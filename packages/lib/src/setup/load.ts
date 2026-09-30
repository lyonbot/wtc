import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WtcError } from "../errors";
import { type Manifest, manifestSchema } from "./schema";

export const SETUP_FILE = "wtc.setup.ts";

export interface LoadedSetup {
  /** Absolute setup directory. */
  dir: string;
  manifest: Manifest;
}

/** Resolve setup dir: explicit flag, then env, then walk up from cwd looking for wtc.setup.ts. */
export function resolveSetupDir(o: { flag?: string; env?: string; cwd: string }): string {
  const explicit = o.flag || o.env;
  if (explicit) return resolve(o.cwd, explicit);
  let d = resolve(o.cwd);
  for (;;) {
    if (existsSync(join(d, SETUP_FILE))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new WtcError("SETUP_NOT_FOUND", `no ${SETUP_FILE} found from ${o.cwd} upwards`, "pass --setup <dir> or set WTC_SETUP");
}

export async function loadSetup(dir: string): Promise<LoadedSetup> {
  const abs = resolve(dir);
  const file = join(abs, SETUP_FILE);
  if (!existsSync(file)) throw new WtcError("SETUP_NOT_FOUND", `${file} does not exist`);
  const mod = await import(pathToFileURL(file).href);
  const parsed = manifestSchema.safeParse(mod.default);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WtcError("INVALID_MANIFEST", `${file}: ${msg}`);
  }
  const manifest = parsed.data as Manifest;
  for (const m of manifest.mounts) {
    if (m.type !== "bind") continue;
    m.source = resolve(abs, m.source); // relative bind sources are relative to the setup dir
    if (!existsSync(m.source))
      throw new WtcError("INVALID_MANIFEST", `${file}: bind source does not exist: ${m.source}`);
  }
  return { dir: abs, manifest };
}
