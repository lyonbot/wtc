import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/** Scratch dir inside the container $HOME; removed after extraction. */
export const SCRATCH = ".wtc-agent";

/**
 * Files to extract into the container $HOME, keyed by path relative to it.
 * Bun.Archive writes every entry 0644, so modes are shipped as a side list and applied after `tar -x`.
 */
export class Bundle {
  files = new Map<string, Uint8Array>();
  modes = new Map<string, string>();

  add(path: string, data: string | Uint8Array, mode?: string) {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    if (mode) this.modes.set(path, mode);
    else this.modes.delete(path);
  }

  has(path: string) {
    return this.files.has(path);
  }

  /** Tar bytes; includes the modes list at `.wtc-agent/modes`. */
  async tar(): Promise<Uint8Array> {
    const entries: Record<string, Uint8Array> = Object.fromEntries(this.files);
    const modes = [...this.modes].map(([p, m]) => `${m} ${p}\n`).join("");
    entries[`${SCRATCH}/modes`] = new TextEncoder().encode(modes);
    return new Uint8Array(await new Bun.Archive(entries).bytes());
  }
}

/** Always skipped when copying directories. */
const SKIP_NAMES = new Set([".git", ".DS_Store", "node_modules"]);

/**
 * Copy a host directory into the bundle under `dest`. Symlinks are followed (broken ones skipped,
 * cycles cut by realpath); executable files keep 755. `skip(rel)` excludes paths relative to `src`.
 */
export function addDir(b: Bundle, src: string, dest: string, skip: (rel: string) => boolean = () => false) {
  if (!existsSync(src)) return;
  const walk = (abs: string, rel: string, seen: Set<string>) => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return; // broken symlink
    }
    const st = statSync(real);
    if (st.isDirectory()) {
      if (seen.has(real)) return;
      const next = new Set(seen).add(real);
      for (const name of readdirSync(real).sort()) {
        if (SKIP_NAMES.has(name)) continue;
        const r = rel ? `${rel}/${name}` : name;
        if (skip(r)) continue;
        walk(join(abs, name), r, next);
      }
    } else if (st.isFile()) {
      b.add(rel ? `${dest}/${rel}` : dest, readFileSync(real), st.mode & 0o111 ? "755" : undefined);
    }
  };
  walk(src, "", new Set());
}

/** Add a single host file (following symlinks) if it exists. */
export function addFile(b: Bundle, src: string, dest: string, mode?: string) {
  try {
    if (!statSync(src).isFile()) return;
  } catch {
    return;
  }
  b.add(dest, readFileSync(src), mode);
}

/** Deep-map every string in a JSON value. */
export function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

/** Replace path prefixes: `from` itself or `from/...` becomes `to` / `to/...`; first match wins. */
export function prefixRewriter(pairs: [from: string, to: string][]): (s: string) => string {
  return (s) => {
    for (const [from, to] of pairs) {
      if (s === from) return to;
      if (s.startsWith(from + "/")) return to + s.slice(from.length);
    }
    return s;
  };
}

export const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

/** Host-only locations (macOS system dirs, .app bundles, Linux snap/nix): never present in the container. */
const HOST_ONLY = /^\/(Applications|Users|Volumes|System|Library|opt\/homebrew|private|snap|nix)(\/|$)|\.app(\/|$)/;

/** True when any string in `v` is a host-only path (or under the host home): such MCP servers cannot start in the container. */
export function refsHostPath(v: unknown, home: string): boolean {
  if (typeof v === "string") return v === home || v.startsWith(home + "/") || HOST_ONLY.test(v);
  if (Array.isArray(v)) return v.some((x) => refsHostPath(x, home));
  return !!v && typeof v === "object" && Object.values(v).some((x) => refsHostPath(x, home));
}

/** Drop MCP server entries that reference host-only paths. */
export const portableServers = (servers: Record<string, unknown>, home: string) =>
  Object.fromEntries(Object.entries(servers).filter(([, s]) => !refsHostPath(s, home)));

/** mcp-remote's OAuth token cache (plain files on every OS; shared by any agent that proxies MCP through it). */
export function addMcpRemoteAuth(b: Bundle, home: string, env: Record<string, string | undefined>) {
  const before = new Set(b.files.keys());
  addDir(b, env.MCP_REMOTE_CONFIG_DIR || join(home, ".mcp-auth"), ".mcp-auth");
  for (const k of b.files.keys()) if (!before.has(k)) b.modes.set(k, "600");
}
