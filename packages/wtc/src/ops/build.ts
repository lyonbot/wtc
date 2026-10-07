import { resolve } from "node:path";
import type { InstanceContext } from "../instance/instance";
import { imageRef, imageRepo } from "../naming";
import { computeImageHash } from "../setup/image-hash";

export async function hasImage(ctx: InstanceContext, ref: string): Promise<boolean> {
  return (await ctx.rt.imageLs(imageRepo(ctx.setup.manifest.id))).some((i) => i.ref === ref);
}

/** Single image-build implementation (also used by `up`). Skips when the content-hashed tag exists unless `force`. */
export async function build(
  ctx: InstanceContext,
  o: { onLog?: (l: string) => void; force?: boolean } = {},
): Promise<{ ref: string; skipped: boolean }> {
  const { setup, rt } = ctx;
  const m = setup.manifest;
  const ref = imageRef(m.id, await computeImageHash(setup));
  if (!o.force && (await hasImage(ctx, ref))) return { ref, skipped: true };
  try {
    await rt.build({
      context: resolve(setup.dir, m.image.context),
      dockerfile: m.image.dockerfile,
      tag: ref,
      buildArgs: m.image.buildArgs,
      ...(o.onLog ? { onLog: o.onLog } : {}),
    });
  } catch (e) {
    // concurrent builds of the same content-hashed tag (e.g. parallel `up`): the loser fails with
    // "image ... already exists" — the tag it wanted is there, so that is success
    if (!o.force && (await hasImage(ctx, ref))) return { ref, skipped: true };
    throw e;
  }
  return { ref, skipped: false };
}
