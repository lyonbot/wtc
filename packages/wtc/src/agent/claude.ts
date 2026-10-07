import { createHash } from "node:crypto";
import { join } from "node:path";
import { WtcError } from "../errors";
import { addDir, addFile, addMcpRemoteAuth, Bundle, mapStrings, portableServers, prefixRewriter, readJson, SCRATCH } from "./bundle";
import { type AgentContext, type AgentOptions, agentConfigTarget, type AgentDefinition, defineAgent, expandHost, extendAgent } from "./define";
import type { HostEnv } from "./host";

/** settings.json keys that run host programs or point at host paths. */
const SETTINGS_DROP = ["hooks", "statusLine", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "sandbox"];
const PLUGIN_FILES = ["installed_plugins.json", "known_marketplaces.json", "config.json", "blocklist.json"];
export const CLAUDE_JSON_PATCH = `${SCRATCH}/claude-json.patch.json`;

/**
 * Host Claude config dir, the matching `.claude.json` (a custom config dir keeps both inside it) and the
 * Keychain item claude stores its login under (suffixed with a hash of a custom config dir).
 * `configDir` (a variant's) wins over the host's CLAUDE_CONFIG_DIR.
 */
export function claudePaths(h: HostEnv, configDir?: string) {
  const cfg = configDir ?? h.env.CLAUDE_CONFIG_DIR;
  if (!cfg) return { dir: join(h.home, ".claude"), json: join(h.home, ".claude.json"), keychain: "Claude Code-credentials" };
  const hash = createHash("sha256").update(cfg.normalize("NFC")).digest("hex").slice(0, 8);
  return { dir: cfg, json: join(cfg, ".claude.json"), keychain: `Claude Code-credentials-${hash}` };
}

/** Credentials JSON: macOS Keychain first (the file may be a stale fallback), else `.credentials.json`. */
export async function readClaudeCredentials(h: HostEnv, configDir?: string): Promise<string> {
  const p = claudePaths(h, configDir);
  const valid = (s: string | null | undefined) => {
    if (!s) return false;
    try {
      return !!JSON.parse(s)?.claudeAiOauth;
    } catch {
      return false;
    }
  };
  if (h.platform === "darwin") {
    const k = await h.readKeychain(p.keychain);
    if (valid(k)) return k!.trim();
  }
  const f = readJson(join(p.dir, ".credentials.json"));
  if (f?.claudeAiOauth) return JSON.stringify(f);
  throw new WtcError("AGENT_NO_CREDENTIALS", `no Claude Code login found on the host (${p.dir})`,
    configDir ? `run \`CLAUDE_CONFIG_DIR=${configDir} claude\` on the host and log in` : "run `claude` on the host and log in");
}

/**
 * Build the Claude part of the bundle. `home` is the container $HOME, `cwd` the manifest cwd.
 * `.claude.json` is shipped as a patch and merged in the container (see mergeClaudeJsonScript).
 * `credentials: false` skips the login (the agent env carries a token instead).
 * `configDir` is the host dir to read, `target` the container dir (relative to `home`) it lands in.
 */
export async function claudeBundle(
  h: HostEnv, home: string, cwd: string, o: { credentials?: boolean; configDir?: string; target?: string } = {},
): Promise<Bundle> {
  const b = new Bundle();
  const { dir, json } = claudePaths(h, o.configDir);
  const T = o.target ?? ".claude";
  const C = `${home}/${T}`;
  if (o.credentials !== false) b.add(`${T}/.credentials.json`, await readClaudeCredentials(h, o.configDir), "600");

  // directory-type marketplaces living outside the config dir are copied under plugins/marketplaces/<name>
  const rewrites: [string, string][] = [[dir, C]];
  const known = readJson(join(dir, "plugins", "known_marketplaces.json"));
  for (const [name, m] of Object.entries<any>(known ?? {})) {
    const loc: string | undefined = m?.installLocation ?? m?.source?.path;
    if (m?.source?.source !== "directory" || !loc || loc === dir || loc.startsWith(dir + "/")) continue;
    addDir(b, loc, `${T}/plugins/marketplaces/${name}`);
    rewrites.push([loc, `${C}/plugins/marketplaces/${name}`]);
    if (m.source.path && m.source.path !== loc) rewrites.push([m.source.path, `${C}/plugins/marketplaces/${name}`]);
  }
  const rewrite = prefixRewriter(rewrites);

  const settings = readJson(join(dir, "settings.json"));
  const s: Record<string, unknown> = settings && typeof settings === "object" ? { ...settings } : {};
  for (const k of SETTINGS_DROP) delete s[k];
  s.skipDangerousModePermissionPrompt = true;
  b.add(`${T}/settings.json`, JSON.stringify(mapStrings(s, rewrite), null, 2));

  addFile(b, join(dir, "CLAUDE.md"), `${T}/CLAUDE.md`);
  for (const d of ["rules", "skills", "agents", "commands"]) addDir(b, join(dir, d), `${T}/${d}`);

  const pdir = join(dir, "plugins");
  for (const d of ["cache", "marketplaces"]) addDir(b, join(pdir, d), `${T}/plugins/${d}`);
  for (const f of PLUGIN_FILES) {
    const j = readJson(join(pdir, f));
    if (j !== undefined) b.add(`${T}/plugins/${f}`, JSON.stringify(mapStrings(j, rewrite), null, 2));
  }

  addMcpRemoteAuth(b, h.home, h.env);

  const hj = readJson(json) ?? {};
  const patch: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    // the "make auto mode your default?" nudge blocks the TUI; bypass mode is intended here
    hasSeenAutoDefaultNudge: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true } },
  };
  if (hj.mcpServers && typeof hj.mcpServers === "object") patch.mcpServers = portableServers(hj.mcpServers, h.home);
  if (hj.oauthAccount) patch.oauthAccount = hj.oauthAccount;
  b.add(CLAUDE_JSON_PATCH, JSON.stringify(patch));
  return b;
}

/**
 * Node script run in the container: merge the patch into `.claude.json` (path relative to $HOME in argv[1];
 * top-level keys replaced, `projects.<dir>` deep-merged) and rename atomically, so fields a running claude wrote survive.
 */
export const mergeClaudeJsonScript = `
const fs = require("fs"), home = process.env.HOME, p = home + "/" + (process.argv[1] || ".claude.json");
const patch = JSON.parse(fs.readFileSync(home + "/${CLAUDE_JSON_PATCH}", "utf8"));
let cur = {};
try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const projects = { ...(cur.projects || {}) };
for (const [k, v] of Object.entries(patch.projects || {})) projects[k] = { ...(projects[k] || {}), ...v };
fs.writeFileSync(p + ".wtc-tmp", JSON.stringify({ ...cur, ...patch, projects }, null, 2));
fs.renameSync(p + ".wtc-tmp", p);
`;

export interface ClaudeAgentOptions extends AgentOptions {
  /** host config dir to sync (`~/` = host home) instead of ~/.claude; the container gets CLAUDE_CONFIG_DIR */
  configDir?: string;
}

/** a token / key in the launch env replaces the synced login: no Keychain read (and no macOS prompt) */
const ENV_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Claude Code with the host login and user-level config synced in, permission prompts off (the container is
 * the sandbox). `o` layers on top (see extendAgent); `o.configDir` selects another host config dir.
 */
export function defineClaudeAgent(o: ClaudeAgentOptions = {}): AgentDefinition {
  const { configDir, ...rest } = o;
  const dirs = (c: AgentContext) => {
    const host = configDir ? expandHost(c.host, configDir) : undefined;
    return { host, target: host ? agentConfigTarget(c.host.home, host, c.name) : undefined };
  };
  return extendAgent(defineAgent({
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    // IS_SANDBOX: containers run as root, where claude otherwise refuses --dangerously-skip-permissions
    env: { IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    args: ["--dangerously-skip-permissions"],
    async sync(c) {
      const d = dirs(c);
      if (d.target) c.env.CLAUDE_CONFIG_DIR = `${c.home}/${d.target}`;
      const credentials = !ENV_AUTH.some((k) => k in c.env);
      c.files.merge(await claudeBundle(c.host, c.home, c.cwd, { credentials, configDir: d.host, target: d.target }));
    },
    async afterSync(c) {
      // a custom CLAUDE_CONFIG_DIR keeps .claude.json inside it
      const t = dirs(c).target;
      const json = t ? `${t}/.claude.json` : ".claude.json";
      const r = await c.exec(["bash", "-lc",
        `if command -v node >/dev/null; then node -e "$1" "$2"; elif [ ! -f "$HOME/$2" ]; then cp "$HOME/${CLAUDE_JSON_PATCH}" "$HOME/$2"; fi`,
        "wtc-agent", mergeClaudeJsonScript, json]);
      if (r.exitCode !== 0) throw new WtcError("AGENT_SYNC_FAILED", `merging ${json} failed: ${(r.stderr || r.stdout).trim()}`);
    },
  }), rest);
}
