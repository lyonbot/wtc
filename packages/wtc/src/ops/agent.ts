import { claudeBundle, mergeClaudeJsonScript, CLAUDE_JSON_PATCH } from "../agent/claude";
import { codexBundle } from "../agent/codex";
import { SCRATCH } from "../agent/bundle";
import { defaultHostEnv, type HostEnv } from "../agent/host";
import { WtcError } from "../errors";
import type { InstanceContext } from "../instance/instance";
import type { AgentConfig, AgentKind } from "../setup/schema";
import { mustRun } from "./common";

interface AgentDef {
  bin: string;
  pkg: string;
  /** the container is the sandbox: skip the agent's own permission prompts / inner sandbox */
  args(): string[];
  env: Record<string, string>;
}

export const AGENT_KINDS = ["claude", "codex"] as const satisfies readonly AgentKind[];

export const AGENTS: Record<AgentKind, AgentDef> = {
  claude: {
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    args: () => ["--dangerously-skip-permissions"],
    // IS_SANDBOX: containers run as root, where claude otherwise refuses --dangerously-skip-permissions
    env: { IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  },
  codex: {
    bin: "codex",
    pkg: "@openai/codex",
    // bwrap cannot create namespaces in an unprivileged container; other defaults live in the synced config.toml
    args: () => ["--dangerously-bypass-approvals-and-sandbox"],
    env: {},
  },
};

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Built-in env overlaid with the manifest's: `fromHost` reads the host env, null drops a built-in. */
export function agentEnv(kind: AgentKind, cfg: AgentConfig, hostEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ...AGENTS[kind].env };
  for (const [k, v] of Object.entries(cfg.env)) {
    if (v === null) delete env[k];
    else if (typeof v === "string") env[k] = v;
    else {
      const hv = hostEnv[v.fromHost];
      if (hv === undefined) throw new WtcError("AGENT_ENV_MISSING", `agents.${kind}.env.${k}: host variable ${v.fromHost} is not set`, `export ${v.fromHost} on the host`);
      env[k] = hv;
    }
  }
  return env;
}

/** Full argv run in the container. */
export function agentArgv(kind: AgentKind, cfg: AgentConfig, args: string[], extra: string[] = []): string[] {
  const d = AGENTS[kind];
  return ["bash", "-lc", `exec ${d.bin} "$@"`, d.bin, ...d.args(), ...extra, ...cfg.args, ...args];
}

const tail = (s: string, n = 20) => s.trimEnd().split("\n").slice(-n).join("\n");

/**
 * Run Claude Code / Codex in the instance with the host's login and user-level config synced in.
 * Installs the agent via npm when missing. Returns the agent's exit code.
 */
export async function agent(
  ctx: InstanceContext, name: string, kind: AgentKind, args: string[],
  o: { host?: HostEnv; log?: (line: string) => void } = {},
): Promise<number> {
  const info = await mustRun(ctx, name);
  const host = o.host ?? defaultHostEnv();
  const log = o.log ?? ((l: string) => process.stderr.write(l.endsWith("\n") ? l : l + "\n"));
  const m = ctx.setup.manifest;
  const cfg = m.agents[kind];
  const d = AGENTS[kind];
  const env = agentEnv(kind, cfg, host.env);

  const probe = await ctx.rt.exec(info.name, ["bash", "-lc",
    `printf '%s\\n' "$HOME"; for c in ${d.bin} npm tar node ps; do command -v "$c" >/dev/null && echo "$c=1" || echo "$c=0"; done`]);
  if (probe.exitCode !== 0)
    throw new WtcError("AGENT_IMAGE_UNSUPPORTED", `probing the container failed: ${tail(probe.stderr || probe.stdout, 5)}`, "the image needs bash");
  const [home = "", ...flags] = probe.stdout.trim().split("\n");
  const has = (c: string) => flags.includes(`${c}=1`);
  if (!home.startsWith("/")) throw new WtcError("AGENT_IMAGE_UNSUPPORTED", `container $HOME is not set (got "${home}")`);
  if (!has("tar")) throw new WtcError("AGENT_IMAGE_UNSUPPORTED", "tar is missing in the container", "install tar in the image");

  // read host credentials before installing: no point installing when there is no login
  // a token/key in the agent env replaces the synced login: no Keychain read (and no macOS prompt)
  const envAuth = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((k) => k in env);
  const bundle = kind === "claude" ? await claudeBundle(host, home, m.cwd, { credentials: !envAuth }) : codexBundle(host, m.cwd);

  if (!has(d.bin)) {
    if (!has("npm"))
      throw new WtcError("AGENT_INSTALL_FAILED", `${d.bin} is not installed and npm is missing`, `preinstall ${d.pkg} (or node) in the image`);
    const spec = `${d.pkg}@${cfg.version}`;
    log(`installing ${spec} in ${name}…`);
    const r = await ctx.rt.exec(info.name, ["bash", "-lc",
      `flock /tmp/wtc-agent-install.lock sh -c 'command -v "$1" >/dev/null || npm i -g --no-fund --no-audit "$2"' sh "$1" "$2" && command -v "$1" >/dev/null`,
      "wtc-agent", d.bin, spec], { onLine: log, timeoutMs: INSTALL_TIMEOUT_MS });
    if (r.exitCode !== 0) throw new WtcError("AGENT_INSTALL_FAILED", `npm i -g ${spec} failed:\n${tail(r.stderr || r.stdout)}`, "check the container's network / npm registry");
  }

  const merge = kind === "claude"
    ? ` && if command -v node >/dev/null; then node -e "$1"; elif [ ! -f "$HOME/.claude.json" ]; then cp "$HOME/${CLAUDE_JSON_PATCH}" "$HOME/.claude.json"; fi`
    : "";
  const sync = await ctx.rt.exec(info.name, ["bash", "-lc",
    `tar -x -C "$HOME" && while read -r m p; do chmod "$m" "$HOME/$p"; done < "$HOME/${SCRATCH}/modes"${merge}; rc=$?; rm -rf "$HOME/${SCRATCH}"; exit $rc`,
    "wtc-agent", mergeClaudeJsonScript], { input: await bundle.tar() });
  if (sync.exitCode !== 0) throw new WtcError("AGENT_SYNC_FAILED", `syncing ${kind} config into the container failed: ${tail(sync.stderr || sync.stdout, 5)}`);

  // codex's shared app-server daemon needs `ps` (procps), which slim images lack; embedded mode works without it
  const extra = kind === "codex" && !has("ps") ? ["--no-daemon"] : [];
  return ctx.rt.execInteractive(info.name, agentArgv(kind, cfg, args, extra), { workdir: m.cwd, env });
}
