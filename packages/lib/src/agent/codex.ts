import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WtcError } from "../errors";
import { addDir, addFile, addMcpRemoteAuth, Bundle, portableServers } from "./bundle";
import { type AgentContext, type AgentOptions, agentConfigTarget, type AgentDefinition, defineAgent, expandHost, extendAgent } from "./define";
import type { HostEnv } from "./host";

/** config.toml keys worth carrying into a container; the rest is host paths, host commands or desktop-only. */
const CONFIG_KEEP = ["model", "model_provider", "model_reasoning_effort", "service_tier", "model_providers", "mcp_servers", "features"];

/** Host Codex home: a variant's `configDir`, else CODEX_HOME, else ~/.codex. */
export const codexDir = (h: HostEnv, configDir?: string) => configDir || h.env.CODEX_HOME || join(h.home, ".codex");

/**
 * Build the Codex part of the bundle; `cwd` is pre-trusted so the TUI skips its folder-trust prompt.
 * `configDir` is the host dir to read, `target` the container dir (relative to $HOME) it lands in.
 */
export function codexBundle(h: HostEnv, cwd: string, o: { configDir?: string; target?: string } = {}): Bundle {
  const b = new Bundle();
  const dir = codexDir(h, o.configDir);
  const T = o.target ?? ".codex";
  let auth: Uint8Array;
  try {
    auth = readFileSync(join(dir, "auth.json"));
  } catch {
    throw new WtcError("AGENT_NO_CREDENTIALS", `no Codex login found on the host (${join(dir, "auth.json")})`,
      `run \`${o.configDir ? `CODEX_HOME=${o.configDir} ` : ""}codex login\` on the host; with cli_auth_credentials_store = "keyring" set it to "file"`);
  }
  b.add(`${T}/auth.json`, auth, "600");
  // MCP OAuth tokens when the host uses file storage (e.g. Linux without a keyring); Keychain-stored ones are not read
  addFile(b, join(dir, ".credentials.json"), `${T}/.credentials.json`, "600");
  let toml = "";
  try {
    toml = readFileSync(join(dir, "config.toml"), "utf8");
  } catch { /* no config */ }
  b.add(`${T}/config.toml`, filterCodexConfig(toml, h.home, cwd));
  addFile(b, join(dir, "AGENTS.md"), `${T}/AGENTS.md`);
  addDir(b, join(dir, "skills"), `${T}/skills`, (rel) => rel === ".system");
  addDir(b, join(h.home, ".agents", "skills"), ".agents/skills");
  addMcpRemoteAuth(b, h.home, h.env);
  return b;
}

/**
 * Keep CONFIG_KEEP, drop MCP servers that reference host-only paths (e.g. desktop-registered local services),
 * and add container defaults. Written to the file rather than passed as `-c`: any `-c` makes codex fall back
 * to embedded mode, and it does not satisfy the folder-trust check.
 */
export function filterCodexConfig(src: string, home: string, cwd: string): string {
  const cfg = Bun.TOML.parse(src) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_KEEP) if (k in cfg) out[k] = cfg[k];
  const servers = out.mcp_servers;
  if (servers && typeof servers === "object") out.mcp_servers = portableServers(servers as Record<string, unknown>, home);
  out.check_for_update_on_startup = false;
  out.analytics = { enabled: false };
  out.projects = { [cwd]: { trust_level: "trusted" } };
  return toToml(out);
}

const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
function value(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${key(k)} = ${value(x)}`).join(", ")} }`;
  return JSON.stringify(String(v));
}

/** Minimal TOML writer for parsed config values (tables become [headers], arrays of tables stay inline). */
export function toToml(obj: Record<string, unknown>, path: string[] = []): string {
  const scalars = Object.entries(obj).filter(([, v]) => !isTable(v));
  const tables = Object.entries(obj).filter(([, v]) => isTable(v)) as [string, Record<string, unknown>][];
  let s = "";
  if (path.length && (scalars.length || !tables.length)) s += `[${path.map(key).join(".")}]\n`;
  for (const [k, v] of scalars) s += `${key(k)} = ${value(v)}\n`;
  if (s) s += "\n";
  for (const [k, v] of tables) s += toToml(v, [...path, k]);
  return s;
}

export interface CodexAgentOptions extends AgentOptions {
  /** host Codex home to sync (`~/` = host home) instead of CODEX_HOME / ~/.codex; the container gets CODEX_HOME */
  configDir?: string;
}

/**
 * Codex with the host login and user-level config synced in, approvals and inner sandbox off.
 * `o` layers on top (see extendAgent); `o.configDir` selects another host Codex home.
 */
export function defineCodexAgent(o: CodexAgentOptions = {}): AgentDefinition {
  const { configDir, ...rest } = o;
  return extendAgent(defineAgent({
    bin: "codex",
    pkg: "@openai/codex",
    // bwrap cannot create namespaces in an unprivileged container; other defaults live in the synced config.toml.
    // the shared app-server daemon needs `ps` (procps), which slim images lack; embedded mode works without it
    args: (c: AgentContext) => ["--dangerously-bypass-approvals-and-sandbox", ...(c.has("ps") ? [] : ["--no-daemon"])],
    sync(c) {
      const host = configDir ? expandHost(c.host, configDir) : undefined;
      const target = host ? agentConfigTarget(c.host.home, host, c.name) : undefined;
      if (target) c.env.CODEX_HOME = `${c.home}/${target}`;
      c.files.merge(codexBundle(c.host, c.cwd, { configDir: host, target }));
    },
  }), rest);
}
