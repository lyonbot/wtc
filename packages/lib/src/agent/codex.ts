import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WtcError } from "../errors";
import { addDir, addFile, addMcpRemoteAuth, Bundle, portableServers } from "./bundle";
import type { HostEnv } from "./host";

/** config.toml keys worth carrying into a container; the rest is host paths, host commands or desktop-only. */
const CONFIG_KEEP = ["model", "model_provider", "model_reasoning_effort", "service_tier", "model_providers", "mcp_servers", "features"];

export const codexDir = (h: HostEnv) => h.env.CODEX_HOME || join(h.home, ".codex");

/** Build the Codex part of the bundle; `cwd` is pre-trusted so the TUI skips its folder-trust prompt. */
export function codexBundle(h: HostEnv, cwd: string): Bundle {
  const b = new Bundle();
  const dir = codexDir(h);
  let auth: Uint8Array;
  try {
    auth = readFileSync(join(dir, "auth.json"));
  } catch {
    throw new WtcError("AGENT_NO_CREDENTIALS", `no Codex login found on the host (${join(dir, "auth.json")})`,
      "run `codex login` on the host; with cli_auth_credentials_store = \"keyring\" set it to \"file\"");
  }
  b.add(".codex/auth.json", auth, "600");
  // MCP OAuth tokens when the host uses file storage (e.g. Linux without a keyring); Keychain-stored ones are not read
  addFile(b, join(dir, ".credentials.json"), ".codex/.credentials.json", "600");
  let toml = "";
  try {
    toml = readFileSync(join(dir, "config.toml"), "utf8");
  } catch { /* no config */ }
  b.add(".codex/config.toml", filterCodexConfig(toml, h.home, cwd));
  addFile(b, join(dir, "AGENTS.md"), ".codex/AGENTS.md");
  addDir(b, join(dir, "skills"), ".codex/skills", (rel) => rel === ".system");
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
