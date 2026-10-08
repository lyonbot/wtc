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

/**
 * `NO_PROXY` / `no_proxy` entries that make a client bypass the proxy for `localhost` / `127.0.0.1` (the usual tunnel target).
 * Both vars are read: clients disagree on precedence (curl prefers `no_proxy`, Go `NO_PROXY`), and an empty one may shadow the other.
 * Matches case-insensitively, ignoring a `:port` suffix and a leading `.` / `*.`; `*` and IPv4 CIDRs covering 127.0.0.1 count too.
 */
export function noProxyLoopback(env: Record<string, string | undefined> = process.env): string[] {
  const entries = `${env.NO_PROXY ?? ""},${env.no_proxy ?? ""}`.split(",").map((x) => x.trim()).filter(Boolean);
  const hit = (e: string) => {
    const h = e.toLowerCase().replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (h === "*" || h === "localhost" || h === "127.0.0.1") return true;
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(h);
    if (!m) return false;
    const bits = Number(m[5]);
    if (bits > 32) return false;
    const ip = m.slice(1, 5).reduce((a, o) => a * 256 + Number(o), 0);
    const div = 2 ** (32 - bits);
    return Math.floor(ip / div) === Math.floor(0x7f000001 / div);
  };
  return [...new Set(entries.filter(hit))];
}

/** Like mustExist, and the container must be running. */
export async function mustRun(ctx: InstanceContext, name: string): Promise<ContainerInfo> {
  const info = await mustExist(ctx, name);
  if (info.state !== "running" && info.state !== "restarting")
    throw new WtcError("NOT_RUNNING", `instance ${name} is ${info.state}`, `wtc start ${name}`);
  return info;
}
