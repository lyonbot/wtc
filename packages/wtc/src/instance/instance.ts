import { mkdir, readFile, rm as rmPath, writeFile } from "node:fs/promises";
import { WtcError } from "../errors";
import { type Health, runChecks } from "../health/health";
import { assertId, containerName, imageRef, instanceVolume, LABEL, pnpmVolume, setupVolume } from "../naming";
import type { ContainerInfo, Runtime } from "../runtime/types";
import { computeImageHash } from "../setup/image-hash";
import type { LoadedSetup } from "../setup/load";
import type { BootEvent, ConfigSnapshot } from "../setup/schema";
import { type InstanceState, mergeState, readStatus } from "../status/status";
import { build, hasImage } from "../ops/build";
import { assertBindSourcesExist, resolveContainer } from "./container";
import { assertBindable, buildCreateSpec, instancePaths, resolveBindSource } from "./create-spec";
import { assertKnownParams, diffParams, resolveParams } from "./params";
import { allocateSocksPort } from "./ports";
import { prepareSshDir } from "./ssh";

export interface InstanceContext {
  setup: LoadedSetup;
  rt: Runtime;
  /** From ensureKit(); bind-mounted at /wtc/bin. */
  kitDir: string;
  home: string;
  now: () => Date;
  /** Host LAN IPv4 addresses, for socks urls when bound to 0.0.0.0. */
  lanAddrs: () => string[];
  /** status poll interval while waiting in `up` (default 250ms). */
  pollMs?: number;
}

export interface InstanceSummary {
  name: string;
  container: string;
  state: InstanceState;
  phase: string | null;
  message?: string;
  health?: Health;
  socks?: { bind: string; port: number; urls: string[] };
  staleImage: boolean;
  bootId?: string;
}

export type UpEvent =
  | { type: "action"; action: "build" | "create" | "start" | "wait"; detail?: string }
  | { type: "status"; summary: InstanceSummary }
  | { type: "done"; summary: InstanceSummary; logTail?: string[] };

/** `.wtc/run/<name>/create.json`: create-time parameters (auxiliary; runtime is the source of truth). */
export interface CreateRecord {
  params: Record<string, string>;
  socksBind: string;
  socksHostPort: number;
  imageRef: string;
  createdAt: string;
}

const MAX_PORT_ATTEMPTS = 5;
const LOG_TAIL = 50;

async function readConfig(file: string): Promise<ConfigSnapshot | null> {
  try {
    const { params, container } = JSON.parse(await readFile(file, "utf8")) as ConfigSnapshot;
    return { params, container };
  } catch {
    return null;
  }
}

async function readCreate(file: string): Promise<CreateRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as CreateRecord;
  } catch {
    return null;
  }
}

async function logTail(ctx: InstanceContext, name: string, bootId?: string): Promise<string[] | undefined> {
  if (!bootId) return undefined;
  try {
    const txt = await readFile(`${instancePaths(ctx.setup.dir, name).log}/init.${bootId}.log`, "utf8");
    const lines = txt.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-LOG_TAIL);
  } catch {
    return undefined;
  }
}

export async function summarize(ctx: InstanceContext, name: string, info: ContainerInfo | null, hash: string): Promise<InstanceSummary> {
  const p = instancePaths(ctx.setup.dir, name);
  const merged = mergeState(info, await readStatus(p.status));
  const s: InstanceSummary = {
    name,
    container: containerName(ctx.setup.manifest.id, name),
    state: merged.state,
    phase: merged.phase,
    staleImage: info ? info.image.split(":").pop() !== hash : false,
  };
  if (merged.message !== undefined) s.message = merged.message;
  if (merged.bootId !== undefined) s.bootId = merged.bootId;
  const port = Number(info?.labels[LABEL.socksHostPort]);
  if (info && port) {
    const bind = (await readCreate(p.create))?.socksBind ?? ctx.setup.manifest.socksBind;
    const hosts = ["127.0.0.1", ...(bind === "0.0.0.0" ? ctx.lanAddrs() : [])];
    s.socks = { bind, port, urls: hosts.map((h) => `socks5h://${h}:${port}`) };
  }
  return s;
}

async function assertNoConflict(ctx: InstanceContext) {
  const { id } = ctx.setup.manifest;
  const other = (await ctx.rt.ps({ [LABEL.setup]: id })).find((c) => c.labels[LABEL.setupDir] !== ctx.setup.dir);
  if (other)
    throw new WtcError(
      "SETUP_ID_CONFLICT",
      `setup id "${id}" is already used by ${other.labels[LABEL.setupDir]} (container ${other.name})`,
      "give this setup a different id in wtc.setup.ts",
    );
}

async function mustInspect(ctx: InstanceContext, name: string): Promise<ContainerInfo> {
  assertId("name", name);
  const info = await ctx.rt.inspect(containerName(ctx.setup.manifest.id, name));
  if (!info) throw new WtcError("NOT_FOUND", `instance ${name} does not exist`, `wtc up ${name}`);
  return info;
}

const isRunning = (i: ContainerInfo) => i.state === "running" || i.state === "restarting";

/** Start an existing container; a taken socks port is not retried (the port is fixed at create, spec §10). */
async function startExisting(ctx: InstanceContext, name: string, info: ContainerInfo) {
  try {
    await ctx.rt.start(info.name);
  } catch (e) {
    if (e instanceof WtcError && e.code === "PORT_IN_USE")
      throw new WtcError(
        "PORT_IN_USE",
        `socks host port ${info.labels[LABEL.socksHostPort]} of ${name} is in use: ${e.message}`,
        `free the port, or recreate: wtc rm ${name} && wtc up ${name}`,
      );
    throw e;
  }
}

/** Create volumes/dirs/container for an absent instance. Returns false if another `up` created it first. */
async function* createInstance(
  ctx: InstanceContext,
  name: string,
  o: { set?: Record<string, string>; socksBind?: string; socksHostPort?: number },
  ref: string,
): AsyncGenerator<UpEvent, boolean> {
  const { rt, setup } = ctx;
  const m = setup.manifest;
  const id = m.id;
  const container = containerName(id, name);
  const p = instancePaths(setup.dir, name);
  const params = resolveParams(m, o.set ?? {});
  const platform = await rt.platform();
  const cfg = await resolveContainer(ctx, name, params);
  await preBoot(ctx, name, "up", { params, container: cfg });

  // fail fast (before build / volumes): every bind source must be shared with the runtime VM
  assertBindable(
    [ctx.kitDir, setup.dir, p.ssh, p.run, p.log, ...cfg.mounts.flatMap((mt) => (mt.type === "bind" ? [resolveBindSource(mt.source, setup.dir, ctx.home)] : []))],
    platform.bindableRoots,
  );
  assertBindSourcesExist(ctx, cfg);

  if (!(await hasImage(ctx, ref))) {
    yield { type: "action", action: "build", detail: ref };
    await build(ctx, {});
  }

  yield { type: "action", action: "create", detail: container };
  const base = { [LABEL.setup]: id, [LABEL.setupDir]: setup.dir };
  const want: [string, Record<string, string>][] = [[pnpmVolume(id), { ...base, [LABEL.scope]: "setup" }]];
  for (const mt of cfg.mounts) {
    if (mt.type !== "volume" || !("scope" in mt)) continue;
    if (mt.scope === "setup") want.push([setupVolume(id, mt.name), { ...base, [LABEL.scope]: "setup" }]);
    else want.push([instanceVolume(id, name, mt.name), { ...base, [LABEL.scope]: "instance", [LABEL.name]: name }]);
  }
  const have = new Set((await rt.volumeLs({ [LABEL.setup]: id })).map((v) => v.name));
  for (const [vol, labels] of want) if (!have.has(vol)) await rt.volumeCreate(vol, labels);

  const { warnings } = await prepareSshDir({ dir: p.ssh, knownHosts: m.ssh.knownHosts, home: ctx.home });
  for (const w of warnings) yield { type: "action", action: "create", detail: `warning: ${w}` };
  await mkdir(p.run, { recursive: true });
  await mkdir(p.log, { recursive: true });

  const socksBind = o.socksBind ?? m.socksBind;
  const exclude = new Set<number>();
  for (let attempt = 1; ; attempt++) {
    const port = o.socksHostPort ?? (await allocateSocksPort(rt, m.socksHostPortRange, exclude));
    const spec = buildCreateSpec({ ctx, name, imageRef: ref, params, container: cfg, socksHostPort: port, socksBind, platform });
    const rec: CreateRecord = { params, socksBind, socksHostPort: port, imageRef: ref, createdAt: ctx.now().toISOString() };
    try {
      await rt.create(spec);
    } catch (e) {
      // runtime name uniqueness is the lock for concurrent `up` of the same name (spec §12)
      if (await rt.inspect(container)) return false;
      throw e;
    }
    await writeFile(p.create, JSON.stringify(rec, null, 2) + "\n"); // only after we own the container
    const redacted = { ...spec, env: { ...spec.env, ...(spec.env.WTC_SOCKS_PASS ? { WTC_SOCKS_PASS: "<redacted>" } : {}) } };
    await writeFile(p.config, JSON.stringify({ params, container: cfg, spec: redacted }, null, 2) + "\n"); // snapshot of what was created
    yield { type: "action", action: "start", detail: `socks ${socksBind}:${port}` };
    try {
      await rt.start(container);
      return true;
    } catch (e) {
      if (!(e instanceof WtcError && e.code === "PORT_IN_USE")) throw e;
      await rt.rm(container, true);
      if (o.socksHostPort !== undefined || attempt >= MAX_PORT_ATTEMPTS)
        throw new WtcError("PORT_IN_USE", `socks host port ${port} is in use: ${e.message}`, "free the port or pass another --socks-host-port");
      exclude.add(port);
    }
  }
}

/** Run the manifest's host-side `preBoot` hook; any failure aborts the boot as HOOK_FAILED. */
async function preBoot(ctx: InstanceContext, name: string, event: BootEvent, config: ConfigSnapshot): Promise<void> {
  const hook = ctx.setup.manifest.hooks.preBoot;
  if (!hook) return;
  try {
    await hook({ name, event, setupDir: ctx.setup.dir, config });
  } catch (e) {
    throw new WtcError("HOOK_FAILED", `hooks.preBoot failed for ${name} (${event}): ${e instanceof Error ? e.message : String(e)}`, "fix wtc.setup.ts, or catch the error inside the hook to make it best-effort");
  }
}

/** preBoot for an instance that already exists: hands the hook the saved snapshot (re-resolves only if it is missing). */
async function preBootExisting(ctx: InstanceContext, name: string, event: BootEvent): Promise<void> {
  if (!ctx.setup.manifest.hooks.preBoot) return;
  const p = instancePaths(ctx.setup.dir, name);
  let config = await readConfig(p.config);
  if (!config) {
    const params = (await readCreate(p.create))?.params ?? {};
    config = { params, container: await resolveContainer(ctx, name, params) };
  }
  await preBoot(ctx, name, event, config);
}

/**
 * Bring an instance up (spec §8 / §9): absent → create; stopped → start; booting → wait;
 * ready / failed → done immediately. Waits for ready/failed unless `wait === false`.
 */
export async function* up(
  ctx: InstanceContext,
  name: string,
  o: { set?: Record<string, string>; wait?: boolean; socksBind?: string; socksHostPort?: number },
): AsyncIterable<UpEvent> {
  assertId("name", name);
  const { rt, setup } = ctx;
  const m = setup.manifest;
  const container = containerName(m.id, name);
  const p = instancePaths(setup.dir, name);
  await assertNoConflict(ctx);
  const hash = await computeImageHash(setup);

  const existing = await rt.inspect(container);
  if (!existing) {
    yield* createInstance(ctx, name, o, imageRef(m.id, hash));
  } else {
    assertKnownParams(m, o.set ?? {});
    const rec = await readCreate(p.create);
    const bad = rec ? diffParams(rec.params, o.set ?? {}) : [];
    if (rec && o.socksBind !== undefined && o.socksBind !== rec.socksBind) bad.push("socksBind");
    if (rec && o.socksHostPort !== undefined && o.socksHostPort !== rec.socksHostPort) bad.push("socksHostPort");
    if (bad.length)
      throw new WtcError(
        "PARAMS_MISMATCH",
        `${name} was created with different ${bad.join(", ")} (create-time values cannot change)`,
        `wtc rm ${name} && wtc up ${name} …`,
      );
    const s = await summarize(ctx, name, existing, hash);
    if (s.state === "ready" || s.state === "failed") {
      yield { type: "done", summary: s, ...(s.state === "failed" ? { logTail: await logTail(ctx, name, s.bootId) } : {}) };
      return;
    }
    if (s.state === "stopped") {
      await preBootExisting(ctx, name, "up");
      yield { type: "action", action: "start" };
      await startExisting(ctx, name, existing);
    }
  }

  if (o.wait === false) {
    yield { type: "done", summary: await summarize(ctx, name, await rt.inspect(container), hash) };
    return;
  }

  yield { type: "action", action: "wait" };
  // entry enforces readyTimeout itself; this is only a host-side safety cap
  const deadline = ctx.now().getTime() + (m.readyTimeout + 60) * 1000;
  let lastKey = "";
  for (;;) {
    const s = await summarize(ctx, name, await rt.inspect(container), hash);
    if (s.state !== "booting") {
      yield { type: "done", summary: s, ...(s.state === "failed" ? { logTail: await logTail(ctx, name, s.bootId) } : {}) };
      return;
    }
    const key = JSON.stringify([s.phase, s.message, s.bootId]);
    if (key !== lastKey) {
      lastKey = key;
      yield { type: "status", summary: s };
    }
    if (ctx.now().getTime() > deadline) {
      const summary: InstanceSummary = { ...s, state: "failed", message: "timed out waiting for ready (host)" };
      yield { type: "done", summary, logTail: await logTail(ctx, name, s.bootId) };
      return;
    }
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 250));
  }
}

/** Start a stopped instance (no-op when running). */
export async function start(ctx: InstanceContext, name: string): Promise<void> {
  const info = await mustInspect(ctx, name);
  if (isRunning(info)) return;
  await preBootExisting(ctx, name, "start");
  await startExisting(ctx, name, info);
}

export async function stop(ctx: InstanceContext, name: string): Promise<void> {
  const info = await mustInspect(ctx, name);
  if (isRunning(info)) await ctx.rt.stop(info.name);
}

/** Runtime restart: entry starts a new boot and reruns init. */
export async function restart(ctx: InstanceContext, name: string): Promise<void> {
  const info = await mustInspect(ctx, name);
  await preBootExisting(ctx, name, "restart");
  await ctx.rt.restart(info.name);
}

/**
 * Remove an instance (spec §8): preRemove runs in the running container (ready/failed) and can veto;
 * stopped/booting need `force`, which skips preRemove in any state.
 */
export async function rm(ctx: InstanceContext, name: string, o: { force?: boolean }): Promise<void> {
  const info = await mustInspect(ctx, name);
  const m = ctx.setup.manifest;
  const p = instancePaths(ctx.setup.dir, name);
  if (!o.force) {
    const { state } = mergeState(info, await readStatus(p.status));
    if (state !== "ready" && state !== "failed")
      throw new WtcError("RM_NEEDS_RUNNING", `${name} is ${state}; preRemove needs a running instance`, `wtc start ${name} or use --force`);
    if (m.preRemove) {
      const r = await ctx.rt.exec(info.name, ["bash", "-lc", m.preRemove], { workdir: m.cwd });
      if (r.exitCode !== 0)
        throw new WtcError(
          "PREREMOVE_REJECTED",
          `preRemove rejected removing ${name} (exit ${r.exitCode})${(r.stdout + r.stderr).trim() ? `:\n${(r.stdout + r.stderr).trim()}` : ""}`,
          "resolve the issue, or use --force",
        );
    }
  }
  await ctx.rt.rm(info.name, true);
  for (const v of await ctx.rt.volumeLs({ [LABEL.setup]: m.id, [LABEL.name]: name }))
    if (v.labels[LABEL.scope] === "instance") await ctx.rt.volumeRm(v.name);
  await rmPath(p.run, { recursive: true, force: true });
  await rmPath(p.log, { recursive: true, force: true });
}

/** All instances of this setup (runtime is the source of truth). Health is not computed here. */
export async function ls(ctx: InstanceContext): Promise<InstanceSummary[]> {
  const hash = await computeImageHash(ctx.setup);
  const cs = (await ctx.rt.ps({ [LABEL.setup]: ctx.setup.manifest.id }))
    .filter((c) => c.labels[LABEL.name])
    .sort((a, b) => (a.labels[LABEL.name]! < b.labels[LABEL.name]! ? -1 : 1));
  return Promise.all(cs.map((c) => summarize(ctx, c.labels[LABEL.name]!, c, hash)));
}

/** One instance's summary; runs checks for `health` when ready. Absent instances report state "absent". */
export async function status(ctx: InstanceContext, name: string): Promise<InstanceSummary> {
  assertId("name", name);
  const m = ctx.setup.manifest;
  const info = await ctx.rt.inspect(containerName(m.id, name));
  const s = await summarize(ctx, name, info, await computeImageHash(ctx.setup));
  if (s.state === "ready") s.health = (await runChecks(ctx.rt, s.container, m.checks, m.cwd)).health;
  return s;
}
