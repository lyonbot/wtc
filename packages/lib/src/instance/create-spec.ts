import { join, resolve } from "node:path";
import { WtcError } from "../errors";
import { containerName, instanceVolume, LABEL, pnpmVolume, setupVolume } from "../naming";
import type { CreateSpec, PlatformInfo, RuntimeMount } from "../runtime/types";
import { PROTOCOL_VERSION } from "../version";
import type { InstanceContext } from "./instance";

/** Host-side state paths of one instance (spec §5 layout). */
export function instancePaths(setupDir: string, name: string) {
  const run = join(setupDir, ".wtc", "run", name);
  const log = join(setupDir, ".wtc", "log", name);
  return { run, log, ssh: join(run, "ssh"), status: join(run, "status.json"), create: join(run, "create.json") };
}

/** `~` → home; relative → against the setup dir. */
export function resolveBindSource(source: string, setupDir: string, home: string): string {
  const s = source === "~" || source.startsWith("~/") ? home + source.slice(1) : source;
  return resolve(setupDir, s);
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/** Throws BIND_NOT_SHARED when any bind source is outside the runtime's shared roots (colima). */
export function assertBindable(sources: string[], roots: string[] | undefined): void {
  if (!roots) return;
  const bad = sources.filter((s) => !roots.some((r) => under(s, r)));
  if (bad.length)
    throw new WtcError("BIND_NOT_SHARED", `bind sources not shared with the runtime VM: ${bad.join(", ")}`, `move them under ${roots.join(" or ")}`);
}

/** Pure: the full container spec for `wtc up` (spec §6.1, §7, §10). */
export function buildCreateSpec(o: {
  ctx: InstanceContext;
  name: string;
  imageRef: string;
  params: Record<string, string>;
  socksHostPort: number;
  socksBind: string;
  platform: PlatformInfo;
}): CreateSpec {
  const { setup, kitDir, home } = o.ctx;
  const m = setup.manifest;
  const id = m.id;
  const p = instancePaths(setup.dir, o.name);

  const env: Record<string, string> = {
    ...o.params,
    WTC_SETUP_ID: id,
    WTC_NAME: o.name,
    WTC_CWD: m.cwd,
    WTC_INIT: m.init,
    WTC_READY_TIMEOUT: String(m.readyTimeout),
    WTC_SOCKS_PORT: String(m.socksPort),
    WTC_HOST_FORWARDS: m.hostForwards.join(","),
  };
  if (m.socksAuth) {
    env.WTC_SOCKS_USER = m.socksAuth.user;
    env.WTC_SOCKS_PASS = m.socksAuth.pass;
  }

  const mounts: RuntimeMount[] = [
    { type: "volume", source: pnpmVolume(id), target: "/pnpm" },
    { type: "bind", source: kitDir, target: "/wtc/bin", readonly: true },
    { type: "bind", source: setup.dir, target: "/wtc/setup", readonly: true },
    { type: "bind", source: p.ssh, target: "/wtc/ssh", readonly: true },
    { type: "bind", source: p.run, target: "/wtc/run" },
    { type: "bind", source: p.log, target: "/wtc/log" },
  ];
  for (const mt of m.mounts) {
    const ro = mt.readonly ? { readonly: true } : {};
    if (mt.type === "bind") mounts.push({ type: "bind", source: resolveBindSource(mt.source, setup.dir, home), target: mt.target, ...ro });
    else if ("external" in mt) mounts.push({ type: "volume", source: mt.external, target: mt.target, ...ro });
    else {
      const source = mt.scope === "setup" ? setupVolume(id, mt.name) : instanceVolume(id, o.name, mt.name);
      mounts.push({ type: "volume", source, target: mt.target, ...ro });
    }
  }

  assertBindable(mounts.filter((x) => x.type === "bind").map((x) => x.source), o.platform.bindableRoots);
  // agent socket path lives inside the VM on colima; not subject to bindableRoots
  if (o.platform.sshAgentSource) mounts.push({ type: "bind", source: o.platform.sshAgentSource, target: "/wtc/ssh-agent.sock" });

  return {
    name: containerName(id, o.name),
    image: o.imageRef,
    labels: {
      [LABEL.setup]: id,
      [LABEL.setupDir]: setup.dir,
      [LABEL.name]: o.name,
      [LABEL.protocol]: String(PROTOCOL_VERSION),
      [LABEL.socksHostPort]: String(o.socksHostPort),
    },
    env,
    mounts,
    ports: [{ hostIp: o.socksBind, hostPort: o.socksHostPort, containerPort: m.socksPort }],
    entrypoint: ["/wtc/bin/wtc-entry"],
    extraHosts: o.platform.hostGatewayFlag ? ["host.docker.internal:host-gateway"] : [],
  };
}
