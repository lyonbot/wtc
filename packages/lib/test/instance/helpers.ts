import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRuntime } from "../../src/runtime/fake";
import { manifestSchema, type Manifest, type ManifestInput } from "../../src/setup/schema";
import type { InstanceContext } from "../../src/instance/instance";

export const T0 = "2026-01-01T00:00:00.000Z";

export function manifest(m: Partial<ManifestInput> = {}): Manifest {
  return manifestSchema.parse({ id: "demo", ...m }) as Manifest;
}

/** Temp setup dir with image/Dockerfile; returns ctx backed by a FakeRuntime (clock fixed at T0). */
export function mkCtx(m: Partial<ManifestInput> = {}, o: { now?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wtc-inst-"));
  const dir = join(root, "setup");
  const home = join(root, "home");
  mkdirSync(join(dir, "image"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(dir, "image", "Dockerfile"), "FROM scratch\n");
  const rt = new FakeRuntime({ now: () => T0 });
  const ctx: InstanceContext = {
    setup: { dir, manifest: manifest(m) },
    rt,
    kitDir: join(home, ".cache", "wtc", "kit", "x"),
    home,
    now: o.now ?? (() => new Date()),
    lanAddrs: () => ["192.168.1.5"],
    pollMs: 5,
  };
  return { ctx, rt, dir, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export const err = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as { code?: string; message: string; hint?: string } | null;
