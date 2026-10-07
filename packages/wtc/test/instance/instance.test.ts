import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WtcError } from "../../src/errors";
import { ls, restart, rm, start, status, stop, up, type UpEvent } from "../../src/instance/instance";
import { computeImageHash } from "../../src/setup/image-hash";
import { collect, err, mkCtx } from "./helpers";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));
function setup(...a: Parameters<typeof mkCtx>) {
  const t = mkCtx(...a);
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof setup>;
const C = (n: string) => `wtc-demo--${n}`;
const runDir = (t: T, n: string) => join(t.dir, ".wtc", "run", n);
const logDir = (t: T, n: string) => join(t.dir, ".wtc", "log", n);
const ops = (t: T) => t.rt.calls.map((c) => c.op);

/** Simulate the container kit writing status.json (startedAt after the fake container start). */
function writeStatus(t: T, n: string, state: "booting" | "ready" | "failed", o: { bootId?: string; phase?: string; message?: string } = {}) {
  mkdirSync(runDir(t, n), { recursive: true });
  writeFileSync(join(runDir(t, n), "status.json"), JSON.stringify({
    bootId: o.bootId ?? "b1", startedAt: "2026-01-01T00:00:01.000Z", state, phase: o.phase ?? null,
    ...(o.message ? { message: o.message } : {}), history: [],
  }));
}
async function created(t: T, n = "a", set: Record<string, string> = {}) {
  await collect(up(t.ctx, n, { wait: false, set }));
}
const actions = (ev: UpEvent[]) => ev.filter((e) => e.type === "action").map((e) => (e as { action: string }).action);
const last = (ev: UpEvent[]) => ev[ev.length - 1]!;

describe("up (absent)", () => {
  test("invalid name -> INVALID_ID", async () => {
    const t = setup();
    expect((await err(collect(up(t.ctx, "Bad_Name", {}))))?.code).toBe("INVALID_ID");
  });

  test("setupDir conflict -> SETUP_ID_CONFLICT", async () => {
    const t = setup();
    await t.rt.create({ name: C("x"), image: "i", labels: { "wtc.setup": "demo", "wtc.setupDir": "/elsewhere", "wtc.name": "x" }, env: {}, mounts: [], ports: [], entrypoint: [], extraHosts: [] });
    expect((await err(collect(up(t.ctx, "a", { wait: false }))))?.code).toBe("SETUP_ID_CONFLICT");
    expect(t.rt.containers.has(C("a"))).toBe(false);
  });

  test("builds, creates volumes, ssh dir, run/log dirs, create.json, creates and starts", async () => {
    const t = setup({
      params: { BRANCH: { description: "b", default: "main" } },
      container: { mounts: [
        { type: "volume", name: "m2", target: "/m2", scope: "setup" },
        { type: "volume", name: "pg", target: "/pg", scope: "instance" },
        { type: "volume", external: "ext", target: "/ext" },
      ] },
    });
    const ev = await collect(up(t.ctx, "a", { wait: false }));
    expect(actions(ev)).toEqual(["build", "create", "start"]);
    const hash = await computeImageHash(t.ctx.setup);
    const build = t.rt.calls.find((c) => c.op === "build")!.args[0] as { context: string; dockerfile: string; tag: string };
    expect(build).toMatchObject({ context: join(t.dir, "image"), dockerfile: "Dockerfile", tag: `wtc-demo:${hash}` });

    const base = { "wtc.setup": "demo", "wtc.setupDir": t.dir };
    expect(t.rt.volumes.get("wtc-demo.pnpm")).toEqual({ ...base, "wtc.scope": "setup" });
    expect(t.rt.volumes.get("wtc-demo.v.m2")).toEqual({ ...base, "wtc.scope": "setup" });
    expect(t.rt.volumes.get("wtc-demo--a.v.pg")).toEqual({ ...base, "wtc.scope": "instance", "wtc.name": "a" });
    expect(t.rt.volumes.has("ext")).toBe(false);

    expect(existsSync(join(runDir(t, "a"), "ssh", "config"))).toBe(true);
    expect(existsSync(join(runDir(t, "a"), "ssh", "known_hosts"))).toBe(true);
    expect(existsSync(logDir(t, "a"))).toBe(true);

    const cj = JSON.parse(readFileSync(join(runDir(t, "a"), "create.json"), "utf8"));
    expect(cj.params).toEqual({ BRANCH: "main" });
    expect(cj.socksBind).toBe("0.0.0.0");
    expect(cj.socksHostPort).toBeGreaterThanOrEqual(21080);
    expect(cj.imageRef).toBe(`wtc-demo:${hash}`);
    expect(typeof cj.createdAt).toBe("string");

    const c = t.rt.containers.get(C("a"))!;
    expect(c.info.state).toBe("running");
    expect(c.spec.labels["wtc.socksHostPort"]).toBe(String(cj.socksHostPort));
    expect(ops(t).indexOf("create")).toBeLessThan(ops(t).indexOf("start"));
    const done = last(ev);
    expect(done.type).toBe("done");
    expect((done as { summary: { state: string } }).summary.state).toBe("booting");
  });

  test("existing image and volumes are reused", async () => {
    const t = setup({ container: { mounts: [{ type: "volume", name: "m2", target: "/m2", scope: "setup" }] } });
    const hash = await computeImageHash(t.ctx.setup);
    t.rt.images.push({ ref: `wtc-demo:${hash}`, id: "x" });
    t.rt.volumes.set("wtc-demo.pnpm", { "wtc.setup": "demo", keep: "1" });
    const ev = await collect(up(t.ctx, "a", { wait: false }));
    expect(actions(ev)).toEqual(["create", "start"]);
    expect(ops(t)).not.toContain("build");
    expect(t.rt.volumes.get("wtc-demo.pnpm")).toEqual({ "wtc.setup": "demo", keep: "1" });
    expect(t.rt.volumes.has("wtc-demo.v.m2")).toBe(true);
  });

  test("explicit socksBind / socksHostPort are used", async () => {
    const t = setup();
    await collect(up(t.ctx, "a", { wait: false, socksBind: "127.0.0.1", socksHostPort: 23456 }));
    const c = t.rt.containers.get(C("a"))!;
    expect(c.spec.ports).toEqual([{ hostIp: "127.0.0.1", hostPort: 23456, containerPort: 1080 }]);
  });

  test("ssh warnings surface as create action events", async () => {
    const t = setup({ ssh: { knownHosts: ["missing.example"] } });
    const ev = await collect(up(t.ctx, "a", { wait: false }));
    const w = ev.find((e) => e.type === "action" && e.detail?.startsWith("warning: "));
    expect(w).toMatchObject({ type: "action", action: "create" });
    expect((w as { detail: string }).detail).toContain("missing.example");
  });

  test("PORT_IN_USE on first start (non-wtc listener) -> rm, next port, recreate", async () => {
    const t = setup();
    t.rt.failNextStart = new WtcError("PORT_IN_USE", "Bind for 0.0.0.0:21080 failed: port is already allocated");
    const ev = await collect(up(t.ctx, "a", { wait: false }));
    const creates = t.rt.calls.filter((c) => c.op === "create").map((c) => (c.args[0] as { ports: { hostPort: number }[] }).ports[0]!.hostPort);
    expect(creates.length).toBe(2);
    expect(creates[1]).not.toBe(creates[0]);
    expect(t.rt.calls.some((c) => c.op === "rm" && c.args[0] === C("a"))).toBe(true);
    const cj = JSON.parse(readFileSync(join(runDir(t, "a"), "create.json"), "utf8"));
    expect(cj.socksHostPort).toBe(creates[1]);
    expect(t.rt.containers.get(C("a"))!.info.state).toBe("running");
    expect(last(ev).type).toBe("done");
  });

  test("PORT_IN_USE gives up after 5 attempts", async () => {
    const t = setup();
    t.rt.start = async (name: string) => {
      t.rt.calls.push({ op: "start", args: [name] });
      throw new WtcError("PORT_IN_USE", "port is already allocated");
    };
    expect((await err(collect(up(t.ctx, "a", { wait: false }))))?.code).toBe("PORT_IN_USE");
    expect(t.rt.calls.filter((c) => c.op === "create").length).toBe(5);
    expect(t.rt.containers.has(C("a"))).toBe(false);
  });

  test("concurrent up of same name: lost create race -> waits on the existing instance, keeps its create.json", async () => {
    const t = setup();
    const orig = t.rt.create.bind(t.rt);
    t.rt.create = async (spec) => {
      t.rt.create = orig;
      await orig({ ...spec, labels: { ...spec.labels, winner: "other" } }); // the other `up` wins
      await t.rt.start(spec.name);
      return orig(spec); // ours -> name conflict
    };
    writeStatus(t, "a", "ready");
    const d = last(await collect(up(t.ctx, "a", {})));
    expect(d.type).toBe("done");
    expect((d as { summary: { state: string } }).summary.state).toBe("ready");
    expect(existsSync(join(runDir(t, "a"), "create.json"))).toBe(false);
  });

  test("waits until ready", async () => {
    const t = setup();
    setTimeout(() => writeStatus(t, "a", "booting", { phase: "clone" }), 20);
    setTimeout(() => writeStatus(t, "a", "ready"), 60);
    const ev = await collect(up(t.ctx, "a", {}));
    expect(actions(ev)).toContain("wait");
    expect(ev.some((e) => e.type === "status" && e.summary.phase === "clone")).toBe(true);
    const d = last(ev);
    expect(d.type).toBe("done");
    expect((d as { summary: { state: string } }).summary.state).toBe("ready");
  });

  test("failed while waiting -> done with last 50 log lines", async () => {
    const t = setup();
    setTimeout(() => {
      mkdirSync(logDir(t, "a"), { recursive: true });
      writeFileSync(join(logDir(t, "a"), "init.b7.log"), Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n");
      writeStatus(t, "a", "failed", { bootId: "b7", phase: "install" });
    }, 20);
    const d = last(await collect(up(t.ctx, "a", {}))) as Extract<UpEvent, { type: "done" }>;
    expect(d.summary.state).toBe("failed");
    expect(d.logTail!.length).toBe(50);
    expect(d.logTail![0]).toBe("line 30");
    expect(d.logTail![49]).toBe("line 79");
  });

  test("host safety cap readyTimeout+60s -> done failed", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const t = setup({ readyTimeout: 1 }, { now: () => { const d = new Date(now); now += 30_000; return d; } });
    const d = last(await collect(up(t.ctx, "a", {}))) as Extract<UpEvent, { type: "done" }>;
    expect(d.summary.state).toBe("failed");
    expect(d.summary.message).toBe("timed out waiting for ready (host)");
  });
});

describe("up (existing)", () => {
  test("stopped -> start then wait", async () => {
    const t = setup();
    await created(t);
    await t.rt.stop(C("a"));
    t.rt.calls = [];
    setTimeout(() => writeStatus(t, "a", "ready"), 20);
    const ev = await collect(up(t.ctx, "a", {}));
    expect(actions(ev)).toEqual(["start", "wait"]);
    expect(ops(t)).not.toContain("create");
    expect((last(ev) as { summary: { state: string } }).summary.state).toBe("ready");
  });

  test("booting -> wait without start", async () => {
    const t = setup();
    await created(t);
    t.rt.calls = [];
    setTimeout(() => writeStatus(t, "a", "ready"), 20);
    const ev = await collect(up(t.ctx, "a", {}));
    expect(actions(ev)).toEqual(["wait"]);
    expect(ops(t)).not.toContain("start");
  });

  test("ready -> done immediately", async () => {
    const t = setup();
    await created(t);
    writeStatus(t, "a", "ready");
    const ev = await collect(up(t.ctx, "a", {}));
    expect(ev.length).toBe(1);
    expect((ev[0] as { summary: { state: string } }).summary.state).toBe("ready");
  });

  test("failed -> done immediately with logTail", async () => {
    const t = setup();
    await created(t);
    writeFileSync(join(logDir(t, "a"), "init.b1.log"), "boom\n");
    writeStatus(t, "a", "failed");
    const ev = await collect(up(t.ctx, "a", {}));
    expect(ev.length).toBe(1);
    const d = ev[0] as Extract<UpEvent, { type: "done" }>;
    expect(d.summary.state).toBe("failed");
    expect(d.logTail).toEqual(["boom"]);
  });

  test("--set differing from create.json -> PARAMS_MISMATCH", async () => {
    const t = setup({ params: { BRANCH: { description: "b", default: "main" } } });
    await created(t);
    writeStatus(t, "a", "ready");
    const e = await err(collect(up(t.ctx, "a", { set: { BRANCH: "dev" } })));
    expect(e?.code).toBe("PARAMS_MISMATCH");
    expect(e?.message).toContain("BRANCH");
    expect(e?.hint).toContain("wtc rm a && wtc up");
  });

  test("re-up without --set (defaults applied at create) and with same values -> no error", async () => {
    const t = setup({ params: { BRANCH: { description: "b", default: "main" }, X: { description: "x", required: true } } });
    await created(t, "a", { X: "1" });
    writeStatus(t, "a", "ready");
    expect(last(await collect(up(t.ctx, "a", {}))).type).toBe("done");
    expect(last(await collect(up(t.ctx, "a", { set: {} }))).type).toBe("done");
    expect(last(await collect(up(t.ctx, "a", { set: { BRANCH: "main", X: "1" } }))).type).toBe("done");
  });
});

describe("rm", () => {
  async function readyWithVolumes(m: Parameters<typeof mkCtx>[0] = {}) {
    const t = setup({
      ...m,
      container: { mounts: [
        { type: "volume", name: "m2", target: "/m2", scope: "setup" },
        { type: "volume", name: "pg", target: "/pg", scope: "instance" },
      ] },
    });
    await created(t);
    writeStatus(t, "a", "ready");
    return t;
  }

  test("ready: runs preRemove via bash -lc in cwd, then removes container, instance volumes, run/log dirs", async () => {
    const t = await readyWithVolumes({ preRemove: "test ! -e .keep", cwd: "/src" });
    await rm(t.ctx, "a", {});
    const ex = t.rt.calls.find((c) => c.op === "exec")!;
    expect(ex.args[0]).toBe(C("a"));
    expect(ex.args[1]).toEqual(["bash", "-lc", "test ! -e .keep"]);
    expect(ex.args[2]).toMatchObject({ workdir: "/src" });
    expect(t.rt.calls.find((c) => c.op === "rm")!.args).toEqual([C("a"), true]);
    expect(t.rt.containers.has(C("a"))).toBe(false);
    expect(t.rt.volumes.has("wtc-demo--a.v.pg")).toBe(false);
    expect(t.rt.volumes.has("wtc-demo.v.m2")).toBe(true);
    expect(t.rt.volumes.has("wtc-demo.pnpm")).toBe(true);
    expect(existsSync(runDir(t, "a"))).toBe(false);
    expect(existsSync(logDir(t, "a"))).toBe(false);
  });

  test("failed state also runs preRemove", async () => {
    const t = await readyWithVolumes({ preRemove: "true" });
    writeStatus(t, "a", "failed");
    await rm(t.ctx, "a", {});
    expect(ops(t)).toContain("exec");
    expect(t.rt.containers.has(C("a"))).toBe(false);
  });

  test("preRemove non-zero -> PREREMOVE_REJECTED with output, nothing removed", async () => {
    const t = await readyWithVolumes({ preRemove: "check" });
    t.rt.execHandler = () => ({ exitCode: 1, stdout: "uncommitted changes\n", stderr: "in repo\n" });
    const e = await err(rm(t.ctx, "a", {}));
    expect(e?.code).toBe("PREREMOVE_REJECTED");
    expect(e?.message).toContain("uncommitted changes");
    expect(e?.message).toContain("in repo");
    expect(t.rt.containers.has(C("a"))).toBe(true);
    expect(existsSync(runDir(t, "a"))).toBe(true);
  });

  test("preRemove non-zero without output -> message has no dangling colon", async () => {
    const t = await readyWithVolumes({ preRemove: "check" });
    t.rt.execHandler = () => ({ exitCode: 1, stdout: "", stderr: "" });
    const e = await err(rm(t.ctx, "a", {}));
    expect(e?.message).toBe("preRemove rejected removing a (exit 1)");
  });

  test("stopped without --force -> RM_NEEDS_RUNNING", async () => {
    const t = await readyWithVolumes({ preRemove: "true" });
    await t.rt.stop(C("a"));
    const e = await err(rm(t.ctx, "a", {}));
    expect(e?.code).toBe("RM_NEEDS_RUNNING");
    expect(e?.hint).toBe("wtc start a or use --force");
    expect(t.rt.containers.has(C("a"))).toBe(true);
  });

  test("booting without --force -> RM_NEEDS_RUNNING", async () => {
    const t = setup();
    await created(t);
    expect((await err(rm(t.ctx, "a", {})))?.code).toBe("RM_NEEDS_RUNNING");
  });

  test("--force works when stopped and skips preRemove", async () => {
    const t = await readyWithVolumes({ preRemove: "false" });
    await t.rt.stop(C("a"));
    await rm(t.ctx, "a", { force: true });
    expect(ops(t)).not.toContain("exec");
    expect(t.rt.containers.has(C("a"))).toBe(false);
    expect(t.rt.volumes.has("wtc-demo--a.v.pg")).toBe(false);
    expect(existsSync(runDir(t, "a"))).toBe(false);
  });

  test("--force skips preRemove when ready", async () => {
    const t = await readyWithVolumes({ preRemove: "false" });
    await rm(t.ctx, "a", { force: true });
    expect(ops(t)).not.toContain("exec");
    expect(t.rt.containers.has(C("a"))).toBe(false);
  });

  test("absent -> NOT_FOUND", async () => {
    const t = setup();
    expect((await err(rm(t.ctx, "nope", {})))?.code).toBe("NOT_FOUND");
  });
});

describe("start / stop / restart", () => {
  test("restart -> runtime restart", async () => {
    const t = setup();
    await created(t);
    await restart(t.ctx, "a");
    expect(ops(t)).toContain("restart");
  });
  test("start on running -> no-op; start on stopped -> start", async () => {
    const t = setup();
    await created(t);
    t.rt.calls = [];
    await start(t.ctx, "a");
    expect(ops(t)).not.toContain("start");
    await stop(t.ctx, "a");
    expect(t.rt.containers.get(C("a"))!.info.state).toBe("exited");
    await start(t.ctx, "a");
    expect(ops(t)).toContain("start");
    expect(t.rt.containers.get(C("a"))!.info.state).toBe("running");
  });
  test("absent -> NOT_FOUND", async () => {
    const t = setup();
    for (const f of [start, stop, restart]) expect((await err(f(t.ctx, "zz")))?.code).toBe("NOT_FOUND");
  });
});

describe("ls / status", () => {
  test("ls merges status, socks urls, staleImage; no health", async () => {
    const t = setup({ checks: { ok: { run: "true" } } });
    await created(t, "a");
    await collect(up(t.ctx, "b", { wait: false, socksBind: "127.0.0.1" }));
    writeStatus(t, "a", "ready");
    // make b's image stale
    t.rt.containers.get(C("b"))!.info.image = "wtc-demo:oldhash";
    await t.rt.stop(C("b"));
    t.rt.calls = [];
    const list = await ls(t.ctx);
    expect(list.map((s) => s.name)).toEqual(["a", "b"]);
    const [a, b] = list as [typeof list[0], typeof list[0]];
    const pa = Number(t.rt.containers.get(C("a"))!.info.labels["wtc.socksHostPort"]);
    const pb = Number(t.rt.containers.get(C("b"))!.info.labels["wtc.socksHostPort"]);
    expect(a).toMatchObject({ name: "a", container: C("a"), state: "ready", staleImage: false, bootId: "b1" });
    expect(a.socks).toEqual({ bind: "0.0.0.0", port: pa, urls: [`socks5h://127.0.0.1:${pa}`, `socks5h://192.168.1.5:${pa}`] });
    expect(a.health).toBeUndefined();
    expect(b).toMatchObject({ state: "stopped", staleImage: true });
    expect(b.socks).toEqual({ bind: "127.0.0.1", port: pb, urls: [`socks5h://127.0.0.1:${pb}`] });
    expect(ops(t)).not.toContain("exec");
  });

  test("status computes health when ready", async () => {
    const t = setup({ checks: { ok: { run: "true" }, bad: { run: "false" } } });
    await created(t);
    t.rt.execHandler = (_n, cmd) => ({ exitCode: cmd[2] === "true" ? 0 : 1, stdout: "", stderr: "" });
    expect((await status(t.ctx, "a")).health).toBeUndefined(); // booting
    writeStatus(t, "a", "ready", { phase: "start" });
    const s = await status(t.ctx, "a");
    expect(s.state).toBe("ready");
    expect(s.health).toBe("degraded");
  });

  test("status of absent instance", async () => {
    const t = setup();
    expect(await status(t.ctx, "zz")).toMatchObject({ name: "zz", container: C("zz"), state: "absent", staleImage: false });
  });
});

describe("carried-over fixes (task 7)", () => {
  test("new instance: bind sources validated before build/volume creation", async () => {
    const t = setup({ container: { mounts: [{ type: "bind", source: "/somewhere/else", target: "/x" }] } });
    t.rt.platformInfo = { kind: "colima", arch: "arm64", hostGatewayFlag: false, bindableRoots: [t.home] };
    const e = await err(collect(up(t.ctx, "a", { wait: false })));
    expect(e?.code).toBe("BIND_NOT_SHARED");
    expect(ops(t)).not.toContain("build");
    expect(ops(t)).not.toContain("volumeCreate");
  });
  test("existing instance: unknown --set key -> PARAM_UNKNOWN", async () => {
    const t = setup({ params: { A: { description: "a", default: "1" } } });
    await created(t);
    expect((await err(collect(up(t.ctx, "a", { set: { NOPE: "1" } }))))?.code).toBe("PARAM_UNKNOWN");
  });
});

describe("hooks.preBoot", () => {
  const withHook = () => {
    const calls: { name: string; event: string; setupDir: string; config?: unknown }[] = [];
    const t = setup({ hooks: { preBoot: (c) => void calls.push(c) } });
    return { t, calls };
  };

  test("fires on up (create) and on up of a stopped instance, with event up", async () => {
    const { t, calls } = withHook();
    await created(t);
    expect(calls).toMatchObject([{ name: "a", event: "up", setupDir: t.dir }]);
    await t.rt.stop(C("a"));
    await collect(up(t.ctx, "a", { wait: false }));
    expect(calls.map((c) => c.event)).toEqual(["up", "up"]);
  });

  test("fires for start (stopped only) and restart; not for no-op calls", async () => {
    const { t, calls } = withHook();
    await created(t);
    calls.length = 0;
    await start(t.ctx, "a"); // running -> no-op
    writeStatus(t, "a", "ready");
    await collect(up(t.ctx, "a", {})); // ready -> done immediately
    expect(calls).toEqual([]);
    await stop(t.ctx, "a");
    await start(t.ctx, "a");
    await restart(t.ctx, "a");
    expect(calls.map((c) => c.event)).toEqual(["start", "restart"]);
  });

  test("not fired by ls / status / stop / rm", async () => {
    const { t, calls } = withHook();
    await created(t);
    calls.length = 0;
    await ls(t.ctx);
    await status(t.ctx, "a");
    await stop(t.ctx, "a");
    await rm(t.ctx, "a", { force: true });
    expect(calls).toEqual([]);
  });

  test("async hook is awaited; a throw aborts the boot with HOOK_FAILED", async () => {
    let done = false;
    const t1 = setup({ hooks: { preBoot: async () => { await new Promise((r) => setTimeout(r, 20)); done = true; } } });
    await created(t1);
    expect(done).toBe(true);

    const t2 = setup({ hooks: { preBoot: () => { throw new Error("boom"); } } });
    const e = await err(collect(up(t2.ctx, "a", { wait: false })));
    expect(e?.code).toBe("HOOK_FAILED");
    expect(e?.message).toContain("boom");
    expect(t2.rt.containers.has(C("a"))).toBe(false);
  });
});

describe("container (function form)", () => {
  const params = { MODE: { description: "m", default: "a" } };

  test("called once at create with { name, params, setupDir }; result drives spec; start/restart do not call it", async () => {
    const calls: unknown[] = [];
    const t = setup({
      params,
      container: (c) => {
        calls.push(c);
        return { mounts: [{ type: "volume", external: "ext", target: "/ext" }], hostForwards: [5432], env: { FOO: c.params.MODE! } };
      },
    });
    await collect(up(t.ctx, "a", { wait: false, set: { MODE: "b" } }));
    expect(calls).toEqual([{ name: "a", params: { MODE: "b" }, setupDir: t.dir }]);
    const spec = t.rt.containers.get(C("a"))!.spec;
    expect(spec.env).toMatchObject({ FOO: "b", MODE: "b", WTC_HOST_FORWARDS: "5432" });
    expect(spec.mounts.some((m) => m.target === "/ext")).toBe(true);
    await stop(t.ctx, "a");
    await start(t.ctx, "a");
    await restart(t.ctx, "a");
    expect(calls.length).toBe(1);
  });

  test("snapshot config.json: params, container config, redacted spec, socks password redacted", async () => {
    const t = setup({ socksAuth: { user: "u", pass: "secret" }, container: () => ({ env: { FOO: "1" } }) });
    await created(t);
    const raw = readFileSync(join(runDir(t, "a"), "config.json"), "utf8");
    expect(raw).not.toContain("secret");
    const snap = JSON.parse(raw);
    expect(snap.spec.env).toMatchObject({ FOO: "1", WTC_SOCKS_USER: "u", WTC_SOCKS_PASS: "<redacted>" });
    expect(snap.spec.name).toBe(C("a"));
    expect(snap.container).toEqual({ mounts: [], hostForwards: [], env: { FOO: "1" }, annotations: {} });
  });

  test("container() is evaluated first; preBoot gets the config on create and the saved snapshot on start/restart", async () => {
    const order: string[] = [];
    let n = 0;
    const seen: { event: string; config: { params: Record<string, string>; container: { env: Record<string, string>; annotations: Record<string, string> } } }[] = [];
    const t = setup({
      params,
      hooks: { preBoot: (c) => void (order.push("preBoot"), seen.push({ event: c.event, config: c.config as never })) },
      container: async (c) => { order.push("container"); return { env: { N: String(++n) }, annotations: { branch: c.params.MODE! } }; },
    });
    await collect(up(t.ctx, "a", { wait: false, set: { MODE: "b" } }));
    expect(order).toEqual(["container", "preBoot"]);
    await stop(t.ctx, "a");
    await start(t.ctx, "a");
    await restart(t.ctx, "a");
    expect(n).toBe(1); // container() not re-evaluated
    expect(seen.map((x) => x.event)).toEqual(["up", "start", "restart"]);
    for (const x of seen) expect(x.config).toMatchObject({ params: { MODE: "b" }, container: { env: { N: "1" }, annotations: { branch: "b" } } });
  });

  test("throw -> HOOK_FAILED, nothing created", async () => {
    const t = setup({ container: () => { throw new Error("boom"); } });
    const e = await err(collect(up(t.ctx, "a", { wait: false })));
    expect(e?.code).toBe("HOOK_FAILED");
    expect(e?.message).toContain("boom");
    expect(t.rt.containers.has(C("a"))).toBe(false);
    expect(ops(t)).not.toContain("build");
  });

  test("invalid result / env-param collision / missing bind source / socksPort forward -> INVALID_MANIFEST", async () => {
    const bad = async (container: never, p: Record<string, unknown> = {}) => {
      const t = setup({ container, ...p });
      const e = await err(collect(up(t.ctx, "a", { wait: false })));
      expect(e?.code).toBe("INVALID_MANIFEST");
      expect(t.rt.containers.has(C("a"))).toBe(false);
      return e!.message;
    };
    await bad((() => ({ extra: 1 })) as never);
    expect(await bad((() => ({ env: { MODE: "x" } })) as never, { params })).toContain("also a param");
    expect(await bad((() => ({ mounts: [{ type: "bind", source: "/definitely/not/here", target: "/d" }] })) as never)).toContain("does not exist");
    expect(await bad((() => ({ hostForwards: [1080] })) as never)).toContain("socksPort");
    expect(await bad((() => ({ mounts: [{ type: "volume", external: "a", target: "/d" }, { type: "volume", external: "b", target: "/d" }] })) as never)).toContain("duplicate mount target");
  });
});
