import { Bundle, SCRATCH } from "../agent/bundle";
import { type AgentContext, type AgentDefinition, type AgentEnvSpec, fileHelpers } from "../agent/define";
import { defaultHostEnv, type HostEnv } from "../agent/host";
import { WtcError } from "../errors";
import type { InstanceContext } from "../instance/instance";
import { mustRun } from "./common";

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Manifest agent by name; unknown names list the defined ones. */
export function agentDefinition(agents: Record<string, AgentDefinition>, name: string): AgentDefinition {
  const d = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (!d) throw new WtcError("AGENT_UNKNOWN", `unknown agent "${name}"; defined: ${Object.keys(agents).join(", ")}`,
    "define it under agents in wtc.setup.ts (defineAgent / defineClaudeAgent / defineCodexAgent)");
  return d;
}

/** Resolve an env spec: `fromHost` reads the host env (missing is an error), null entries are skipped. */
export function agentEnv(name: string, spec: AgentEnvSpec, hostEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v === null) continue;
    if (typeof v === "string") env[k] = v;
    else {
      const hv = hostEnv[v.fromHost];
      if (hv === undefined) throw new WtcError("AGENT_ENV_MISSING", `agents.${name}.env.${k}: host variable ${v.fromHost} is not set`, `export ${v.fromHost} on the host`);
      env[k] = hv;
    }
  }
  return env;
}

/** Full argv run in the container: definition args, then CLI args. */
export function agentArgv(d: AgentDefinition, ctx: AgentContext, args: string[]): string[] {
  const own = typeof d.args === "function" ? d.args(ctx) : d.args ?? [];
  return ["bash", "-lc", `exec ${d.bin} "$@"`, d.bin, ...own, ...args];
}

const tail = (s: string, n = 20) => s.trimEnd().split("\n").slice(-n).join("\n");

/**
 * Run a manifest agent (built-in claude / codex or a custom definition) in the instance:
 * probe, `sync` hook, npm install when missing, extract the collected files, `afterSync` hook, launch.
 * Returns the agent's exit code.
 */
export async function agent(
  ctx: InstanceContext, name: string, agentName: string, args: string[],
  o: { host?: HostEnv; log?: (line: string) => void } = {},
): Promise<number> {
  const info = await mustRun(ctx, name);
  const host = o.host ?? defaultHostEnv();
  const log = o.log ?? ((l: string) => process.stderr.write(l.endsWith("\n") ? l : l + "\n"));
  const m = ctx.setup.manifest;
  const d = agentDefinition(m.agents, agentName);
  const env = agentEnv(agentName, d.env ?? {}, host.env);

  const cmds = [...new Set([d.bin, "npm", "tar", "node", "ps", ...(d.probe ?? [])])];
  const probe = await ctx.rt.exec(info.name, ["bash", "-lc",
    `printf '%s\\n' "$HOME"; for c in ${cmds.join(" ")}; do command -v "$c" >/dev/null && echo "$c=1" || echo "$c=0"; done`]);
  if (probe.exitCode !== 0)
    throw new WtcError("AGENT_IMAGE_UNSUPPORTED", `probing the container failed: ${tail(probe.stderr || probe.stdout, 5)}`, "the image needs bash");
  const [home = "", ...flags] = probe.stdout.trim().split("\n");
  const has = (c: string) => flags.includes(`${c}=1`);
  if (!home.startsWith("/")) throw new WtcError("AGENT_IMAGE_UNSUPPORTED", `container $HOME is not set (got "${home}")`);
  if (!has("tar")) throw new WtcError("AGENT_IMAGE_UNSUPPORTED", "tar is missing in the container", "install tar in the image");

  const files = new Bundle();
  const actx: AgentContext = {
    name: agentName, host, home, cwd: m.cwd, env, has, files, log,
    ...fileHelpers(host, files),
    exec: (cmd, x) => ctx.rt.exec(info.name, typeof cmd === "string" ? ["bash", "-lc", cmd] : cmd,
      x?.input === undefined ? {} : { input: typeof x.input === "string" ? new TextEncoder().encode(x.input) : x.input }),
  };
  // before the install: no point installing when there is no login
  await d.sync?.(actx);

  if (!has(d.bin)) {
    if (!d.pkg) throw new WtcError("AGENT_INSTALL_FAILED", `${d.bin} is not installed in the container`, `preinstall ${d.bin} in the image or set pkg on agents.${agentName}`);
    if (!has("npm"))
      throw new WtcError("AGENT_INSTALL_FAILED", `${d.bin} is not installed and npm is missing`, `preinstall ${d.pkg} (or node) in the image`);
    const spec = `${d.pkg}@${d.version ?? "latest"}`;
    log(`installing ${spec} in ${name}…`);
    const r = await ctx.rt.exec(info.name, ["bash", "-lc",
      `flock /tmp/wtc-agent-install.lock sh -c 'command -v "$1" >/dev/null || npm i -g --no-fund --no-audit "$2"' sh "$1" "$2" && command -v "$1" >/dev/null`,
      "wtc-agent", d.bin, spec], { onLine: log, timeoutMs: INSTALL_TIMEOUT_MS });
    if (r.exitCode !== 0) throw new WtcError("AGENT_INSTALL_FAILED", `npm i -g ${spec} failed:\n${tail(r.stderr || r.stdout)}`, "check the container's network / npm registry");
  }

  const sync = await ctx.rt.exec(info.name, ["bash", "-lc",
    `tar -x -C "$HOME" && while read -r m p; do chmod "$m" "$HOME/$p"; done < "$HOME/${SCRATCH}/modes"`], { input: await files.tar() });
  try {
    if (sync.exitCode !== 0) throw new WtcError("AGENT_SYNC_FAILED", `syncing ${agentName} config into the container failed: ${tail(sync.stderr || sync.stdout, 5)}`);
    await d.afterSync?.(actx);
  } finally {
    await ctx.rt.exec(info.name, ["bash", "-lc", `rm -rf "$HOME/${SCRATCH}"`]);
  }

  return ctx.rt.execInteractive(info.name, agentArgv(d, actx, args), { workdir: m.cwd, env: actx.env });
}
