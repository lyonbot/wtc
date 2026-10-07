import { WtcError } from "../errors";
import type { InstanceContext } from "../instance/instance";
import { assertId, containerName } from "../naming";
import type { ContainerInfo } from "../runtime/types";

/** Inspect an instance's container or throw NOT_FOUND. */
export async function mustExist(ctx: InstanceContext, name: string): Promise<ContainerInfo> {
  assertId("name", name);
  const info = await ctx.rt.inspect(containerName(ctx.setup.manifest.id, name));
  if (!info) throw new WtcError("NOT_FOUND", `instance ${name} does not exist`, `wtc up ${name}`);
  return info;
}

/** Like mustExist, and the container must be running. */
export async function mustRun(ctx: InstanceContext, name: string): Promise<ContainerInfo> {
  const info = await mustExist(ctx, name);
  if (info.state !== "running" && info.state !== "restarting")
    throw new WtcError("NOT_RUNNING", `instance ${name} is ${info.state}`, `wtc start ${name}`);
  return info;
}
