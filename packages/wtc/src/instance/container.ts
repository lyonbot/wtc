import { existsSync } from "node:fs";
import { WtcError } from "../errors";
import { type ContainerConfig, containerIssues, manifestContainerSchema } from "../setup/schema";
import { resolveBindSource } from "./create-spec";
import type { InstanceContext } from "./instance";

/**
 * The effective create-time container config of an instance: the manifest's static `container`, or the result
 * of calling it. Function errors -> HOOK_FAILED; bad results (schema, duplicate targets, missing bind sources) -> INVALID_MANIFEST.
 */
export async function resolveContainer(ctx: InstanceContext, name: string, params: Record<string, string>): Promise<ContainerConfig> {
  const { setup } = ctx;
  const m = setup.manifest;
  let c: ContainerConfig;
  if (typeof m.container !== "function") c = m.container;
  else {
    let raw: unknown;
    try {
      raw = await m.container({ name, params, setupDir: setup.dir });
    } catch (e) {
      throw new WtcError("HOOK_FAILED", `container() failed for ${name}: ${e instanceof Error ? e.message : String(e)}`, "fix wtc.setup.ts");
    }
    const parsed = manifestContainerSchema.safeParse(raw);
    if (!parsed.success)
      throw new WtcError("INVALID_MANIFEST", `container(): ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    c = parsed.data as ContainerConfig;
  }
  const issues = containerIssues(c, m.socksPort);
  for (const k of Object.keys(c.env)) if (k in params) issues.push(`env ${k} is also a param`);
  if (issues.length) throw new WtcError("INVALID_MANIFEST", `container: ${issues.join("; ")}`);
  return c;
}

/** Every bind source must exist (checked after `hooks.preBoot`, which may create them, and after the VM-sharing check). */
export function assertBindSourcesExist(ctx: InstanceContext, c: ContainerConfig): void {
  const missing = c.mounts.flatMap((mt) => (mt.type === "bind" ? [resolveBindSource(mt.source, ctx.setup.dir, ctx.home)] : [])).filter((src) => !existsSync(src));
  if (missing.length) throw new WtcError("INVALID_MANIFEST", `container: bind source does not exist: ${missing.join(", ")}`);
}
