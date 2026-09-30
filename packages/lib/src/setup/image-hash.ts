import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { LoadedSetup } from "./load";

const SKIP = new Set([".git", "node_modules", ".wtc"]);

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else if (e.isFile()) out.push(relative(root, p));
  }
  return out;
}

/** sha256 over build context files, dockerfile path and buildArgs; first 12 hex chars. */
export async function computeImageHash(s: LoadedSetup): Promise<string> {
  const { image } = s.manifest;
  const ctx = resolve(s.dir, image.context);
  const h = createHash("sha256");
  for (const rel of listFiles(ctx).sort()) {
    h.update(`file:${rel}\0`);
    h.update(readFileSync(join(ctx, rel)));
    h.update("\0");
  }
  h.update(`dockerfile:${image.dockerfile}\0`);
  const args = Object.fromEntries(Object.entries(image.buildArgs).sort(([a], [b]) => (a < b ? -1 : 1)));
  h.update(`args:${JSON.stringify(args)}`);
  return h.digest("hex").slice(0, 12);
}
