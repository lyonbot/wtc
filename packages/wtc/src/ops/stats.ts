import type { InstanceContext } from "../instance/instance";
import { containerName } from "../naming";
import type { ContainerStats } from "../runtime/types";

/** CPU / memory of the given instances (by instance name); stopped or absent ones are omitted. A runtime failure yields {}. */
export async function stats(ctx: InstanceContext, names: string[]): Promise<Record<string, ContainerStats>> {
  const id = ctx.setup.manifest.id;
  try {
    const byContainer = await ctx.rt.stats(names.map((n) => containerName(id, n)));
    const out: Record<string, ContainerStats> = {};
    for (const n of names) {
      const s = byContainer[containerName(id, n)];
      if (s) out[n] = s;
    }
    return out;
  } catch {
    return {};
  }
}
