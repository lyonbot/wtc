import { networkInterfaces, homedir } from "node:os";
import type { CheckResult, Health } from "./health/health";
import * as inst from "./instance/instance";
import type { InstanceContext, InstanceSummary, UpEvent } from "./instance/instance";
import { instancePaths } from "./instance/create-spec";
import { ensureKit } from "./kit/embed";
import { containerName } from "./naming";
import { build } from "./ops/build";
import { doctor } from "./ops/doctor";
import { check, run, shell } from "./ops/exec";
import { gc } from "./ops/gc";
import { logs } from "./ops/logs";
import { open } from "./ops/open";
import { tunnel } from "./ops/tunnel";
import { DockerCliRuntime } from "./runtime/docker-cli";
import type { Runtime } from "./runtime/types";
import { computeImageHash } from "./setup/image-hash";
import { type LoadedSetup, loadSetup } from "./setup/load";
import { watchStatus } from "./status/status";

type Fn<K extends keyof typeof inst> = (typeof inst)[K] extends (ctx: InstanceContext, ...a: infer A) => infer R ? (...a: A) => R : never;

export interface Wtc {
  setup: LoadedSetup;
  build(o?: { onLog?: (l: string) => void; force?: boolean }): Promise<{ ref: string; skipped: boolean }>;
  up: Fn<"up">;
  start: Fn<"start">;
  stop: Fn<"stop">;
  restart: Fn<"restart">;
  rm: Fn<"rm">;
  ls: Fn<"ls">;
  status: Fn<"status">;
  watch(name: string, signal?: AbortSignal): AsyncIterable<InstanceSummary>;
  run(name: string, script: string, args: string[]): Promise<number>;
  check(name: string): Promise<{ health: Health; items: CheckResult[] }>;
  shell(name: string): Promise<number>;
  logs(name: string, o?: { follow?: boolean; boot?: string; signal?: AbortSignal }): AsyncIterable<string>;
  tunnel(name: string): ReturnType<typeof tunnel>;
  open(name: string, editor?: "code" | "cursor"): ReturnType<typeof open>;
  gc(o?: { dryRun?: boolean; pruneStore?: boolean }): ReturnType<typeof gc>;
  doctor(): ReturnType<typeof doctor>;
}
export type { UpEvent };

const lanAddrs = () =>
  Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address));

/** Facade over all operations, bound to one setup dir. */
export async function createWtc(o: { setupDir: string; runtime?: Runtime; cacheDir?: string }): Promise<Wtc> {
  const setup = await loadSetup(o.setupDir);
  const rt = o.runtime ?? new DockerCliRuntime();
  const kitDir = await ensureKit({ arch: (await rt.platform()).arch, ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}) });
  const ctx: InstanceContext = { setup, rt, kitDir, home: homedir(), now: () => new Date(), lanAddrs };
  return {
    setup,
    build: (b) => build(ctx, b),
    up: (n, x) => inst.up(ctx, n, x),
    start: (n) => inst.start(ctx, n),
    stop: (n) => inst.stop(ctx, n),
    restart: (n) => inst.restart(ctx, n),
    rm: (n, x) => inst.rm(ctx, n, x),
    ls: () => inst.ls(ctx),
    status: (n) => inst.status(ctx, n),
    async *watch(name, signal) {
      const hash = await computeImageHash(setup);
      const file = instancePaths(setup.dir, name).status;
      for await (const _ of watchStatus(file, { signal, ...(ctx.pollMs ? { intervalMs: ctx.pollMs } : {}) }))
        yield await inst.summarize(ctx, name, await rt.inspect(containerName(setup.manifest.id, name)), hash);
    },
    run: (n, s, a) => run(ctx, n, s, a),
    check: (n) => check(ctx, n),
    shell: (n) => shell(ctx, n),
    logs: (n, x) => logs(ctx, n, x),
    tunnel: (n) => tunnel(ctx, n),
    open: (n, e) => open(ctx, n, e),
    gc: (x) => gc(ctx, x),
    doctor: () => doctor(ctx),
  };
}
