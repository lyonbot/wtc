import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceContext } from "../instance/instance";
import { containerName, imageRef, imageRepo, LABEL, pnpmVolume } from "../naming";
import { computeImageHash } from "../setup/image-hash";
import { acquireGc } from "../instance/lock";
import { hasImage } from "./build";

export type GcItem = { kind: "dir" | "volume" | "image" | "log"; name: string };
const KEEP_LOGS = 5;
const list = (d: string) => readdir(d).catch(() => [] as string[]);

/**
 * Remove orphaned state (spec §11). `dryRun` only reports. `store` is set iff `pruneStore` was requested.
 * A real run holds the exclusive gc lock (`<setup>/.wtc/lock/gc.*.lock`, see instance/lock.ts) and fails with `LOCKED` while an instance is being created.
 */
export async function gc(ctx: InstanceContext, o: { dryRun?: boolean; pruneStore?: boolean } = {}) {
  const release = o.dryRun ? undefined : await acquireGc(ctx.setup.dir);
  try {
    return await gcLocked(ctx, o);
  } finally {
    await release?.();
  }
}

async function gcLocked(ctx: InstanceContext, o: { dryRun?: boolean; pruneStore?: boolean }) {
  const { rt, setup } = ctx;
  const id = setup.manifest.id;
  const removed: GcItem[] = [];
  const cs = await rt.ps({ [LABEL.setup]: id });
  const live = new Set(cs.map((c) => c.name));
  const hash = await computeImageHash(setup);
  const current = imageRef(id, hash);
  const state = join(setup.dir, ".wtc");
  const del = async (item: GcItem, action: () => Promise<unknown>) => {
    removed.push(item);
    if (!o.dryRun) await action();
  };

  for (const kind of ["run", "log"]) {
    for (const n of await list(join(state, kind))) {
      if (live.has(containerName(id, n))) continue;
      await del({ kind: "dir", name: `${kind}/${n}` }, () => rm(join(state, kind, n), { recursive: true, force: true }));
    }
  }

  for (const v of await rt.volumeLs({ [LABEL.setup]: id, [LABEL.scope]: "instance" })) {
    const n = v.labels[LABEL.name];
    if (n && live.has(containerName(id, n))) continue;
    await del({ kind: "volume", name: v.name }, () => rt.volumeRm(v.name));
  }

  const used = new Set(cs.map((c) => c.image));
  for (const img of await rt.imageLs(imageRepo(id))) {
    if (img.ref === current || used.has(img.ref)) continue;
    await del({ kind: "image", name: img.ref }, () => rt.imageRm(img.ref));
  }

  for (const c of cs) {
    const n = c.labels[LABEL.name];
    if (!n) continue;
    const dir = join(state, "log", n);
    const files = (await list(dir)).filter((f) => /^init\..+\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOGS)))
      await del({ kind: "log", name: `log/${n}/${f}` }, () => rm(join(dir, f), { force: true }));
  }

  // decided before acting so a dry run reports exactly what a real run would do (prune needs the current image)
  let store: "pruned" | "would-prune" | "no-image" | "failed" | undefined;
  if (o.pruneStore) {
    if (!(await hasImage(ctx, current))) store = "no-image";
    else if (o.dryRun) store = "would-prune";
    else {
      const r = await rt.runOnce({
        image: current,
        cmd: ["bash", "-lc", "flock -x /pnpm/.wtc-lock pnpm store prune"],
        mounts: [{ type: "volume", source: pnpmVolume(id), target: "/pnpm" }],
        // same vars as kit/bin/wtc-entry (which picks one GVS var by pnpm version); setting both is harmless
        env: {
          PNPM_CONFIG_STORE_DIR: "/pnpm/store",
          PNPM_CONFIG_CACHE_DIR: "/pnpm/cache",
          PNPM_CONFIG_VIRTUAL_STORE_TYPE: "global",
          PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE: "true",
        },
      });
      store = r.exitCode === 0 ? "pruned" : "failed";
    }
  }
  return { removed, storePruned: store === "pruned", ...(store ? { store } : {}) };
}
