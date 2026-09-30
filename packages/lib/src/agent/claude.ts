import { join } from "node:path";
import { WtcError } from "../errors";
import { addDir, addFile, addMcpRemoteAuth, Bundle, mapStrings, portableServers, prefixRewriter, readJson, SCRATCH } from "./bundle";
import type { HostEnv } from "./host";

/** settings.json keys that run host programs or point at host paths. */
const SETTINGS_DROP = ["hooks", "statusLine", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "sandbox"];
const PLUGIN_FILES = ["installed_plugins.json", "known_marketplaces.json", "config.json", "blocklist.json"];
export const CLAUDE_JSON_PATCH = `${SCRATCH}/claude-json.patch.json`;

/** Host Claude config dir and the matching `.claude.json` (CLAUDE_CONFIG_DIR keeps both inside it). */
export function claudePaths(h: HostEnv) {
  const cfg = h.env.CLAUDE_CONFIG_DIR;
  return cfg ? { dir: cfg, json: join(cfg, ".claude.json") } : { dir: join(h.home, ".claude"), json: join(h.home, ".claude.json") };
}

/** Credentials JSON: macOS Keychain first (the file may be a stale fallback), else `.credentials.json`. */
export async function readClaudeCredentials(h: HostEnv): Promise<string> {
  const valid = (s: string | null | undefined) => {
    if (!s) return false;
    try {
      return !!JSON.parse(s)?.claudeAiOauth;
    } catch {
      return false;
    }
  };
  if (h.platform === "darwin") {
    const k = await h.readKeychain("Claude Code-credentials");
    if (valid(k)) return k!.trim();
  }
  const f = readJson(join(claudePaths(h).dir, ".credentials.json"));
  if (f?.claudeAiOauth) return JSON.stringify(f);
  throw new WtcError("AGENT_NO_CREDENTIALS", "no Claude Code login found on the host", "run `claude` on the host and log in");
}

/**
 * Build the Claude part of the bundle. `home` is the container $HOME, `cwd` the manifest cwd.
 * `.claude.json` is shipped as a patch and merged in the container (see mergeClaudeJsonScript).
 * `credentials: false` skips the login (the agent env carries a token instead).
 */
export async function claudeBundle(h: HostEnv, home: string, cwd: string, o: { credentials?: boolean } = {}): Promise<Bundle> {
  const b = new Bundle();
  const { dir, json } = claudePaths(h);
  const C = `${home}/.claude`;
  if (o.credentials !== false) b.add(".claude/.credentials.json", await readClaudeCredentials(h), "600");

  // directory-type marketplaces living outside the config dir are copied under plugins/marketplaces/<name>
  const rewrites: [string, string][] = [[dir, C]];
  const known = readJson(join(dir, "plugins", "known_marketplaces.json"));
  for (const [name, m] of Object.entries<any>(known ?? {})) {
    const loc: string | undefined = m?.installLocation ?? m?.source?.path;
    if (m?.source?.source !== "directory" || !loc || loc === dir || loc.startsWith(dir + "/")) continue;
    addDir(b, loc, `.claude/plugins/marketplaces/${name}`);
    rewrites.push([loc, `${C}/plugins/marketplaces/${name}`]);
    if (m.source.path && m.source.path !== loc) rewrites.push([m.source.path, `${C}/plugins/marketplaces/${name}`]);
  }
  const rewrite = prefixRewriter(rewrites);

  const settings = readJson(join(dir, "settings.json"));
  const s: Record<string, unknown> = settings && typeof settings === "object" ? { ...settings } : {};
  for (const k of SETTINGS_DROP) delete s[k];
  s.skipDangerousModePermissionPrompt = true;
  b.add(".claude/settings.json", JSON.stringify(mapStrings(s, rewrite), null, 2));

  addFile(b, join(dir, "CLAUDE.md"), ".claude/CLAUDE.md");
  for (const d of ["rules", "skills", "agents", "commands"]) addDir(b, join(dir, d), `.claude/${d}`);

  const pdir = join(dir, "plugins");
  for (const d of ["cache", "marketplaces"]) addDir(b, join(pdir, d), `.claude/plugins/${d}`);
  for (const f of PLUGIN_FILES) {
    const j = readJson(join(pdir, f));
    if (j !== undefined) b.add(`.claude/plugins/${f}`, JSON.stringify(mapStrings(j, rewrite), null, 2));
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
 * Node script run in the container: merge the patch into ~/.claude.json (top-level keys replaced,
 * `projects.<dir>` deep-merged) and rename atomically, so fields a running claude wrote survive.
 */
export const mergeClaudeJsonScript = `
const fs = require("fs"), home = process.env.HOME, p = home + "/.claude.json";
const patch = JSON.parse(fs.readFileSync(home + "/${CLAUDE_JSON_PATCH}", "utf8"));
let cur = {};
try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const projects = { ...(cur.projects || {}) };
for (const [k, v] of Object.entries(patch.projects || {})) projects[k] = { ...(projects[k] || {}), ...v };
fs.writeFileSync(p + ".wtc-tmp", JSON.stringify({ ...cur, ...patch, projects }, null, 2));
fs.renameSync(p + ".wtc-tmp", p);
`;
