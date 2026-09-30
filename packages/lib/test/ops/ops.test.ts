import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { up } from "../../src/instance/instance";
import { build } from "../../src/ops/build";
import { run, check, shell } from "../../src/ops/exec";
import { logs } from "../../src/ops/logs";
import { tunnel } from "../../src/ops/tunnel";
import { open } from "../../src/ops/open";
import { gc } from "../../src/ops/gc";
import { doctor } from "../../src/ops/doctor";
import { computeImageHash } from "../../src/setup/image-hash";
import { collect, err, mkCtx } from "../instance/helpers";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));
function setup(...a: Parameters<typeof mkCtx>) {
  const t = mkCtx(...a);
  cleanups.push(t.cleanup);
  return t;
}
const created = (t: ReturnType<typeof setup>, n = "a") => collect(up(t.ctx, n, { wait: false }));
const ops = (t: ReturnType<typeof setup>) => t.rt.calls.map((c) => c.op);

describe("build", () => {
  test("builds, then skips when image exists unless force", async () => {
    const t = setup();
    const hash = await computeImageHash(t.ctx.setup);
    expect(await build(t.ctx, {})).toEqual({ ref: `wtc-demo:${hash}`, skipped: false });
    expect(await build(t.ctx, {})).toEqual({ ref: `wtc-demo:${hash}`, skipped: true });
    expect(ops(t).filter((o) => o === "build").length).toBe(1);
    expect((await build(t.ctx, { force: true })).skipped).toBe(false);
    expect(ops(t).filter((o) => o === "build").length).toBe(2);
  });

  test("a failed build is success when a concurrent build produced the tag", async () => {
    const t = setup();
    const hash = await computeImageHash(t.ctx.setup);
    t.rt.build = async (o) => {
      t.rt.images.push({ ref: o.tag, id: "sha256:other" }); // the concurrent winner
      throw new Error(`image "docker.io/library/${o.tag}": already exists`);
    };
    expect(await build(t.ctx, {})).toEqual({ ref: `wtc-demo:${hash}`, skipped: true });
    t.rt.images = [];
    t.rt.build = async () => { throw new Error("boom"); };
    expect((await err(build(t.ctx, {})))?.message ?? "").toContain("boom");
    // forced rebuild failure is never swallowed, even though the tag exists
    t.rt.images = [{ ref: `wtc-demo:${hash}`, id: "sha256:old" }];
    t.rt.build = async () => { throw new Error("forced boom"); };
    expect((await err(build(t.ctx, { force: true })))?.message ?? "").toContain("forced boom");
  });
});

describe("run / check / shell", () => {
  test("run builds bash -lc argv with cwd; unknown script lists available", async () => {
    const t = setup({ scripts: { test: { run: "pnpm test", description: "t" }, lint: { run: "pnpm lint", description: "l" } } });
    await created(t);
    expect(await run(t.ctx, "a", "test", ["-x", "y"])).toBe(0);
    const c = t.rt.calls.filter((x) => x.op === "execInteractive").pop()!;
    expect(c.args[0]).toBe("wtc-demo--a");
    expect(c.args[1]).toEqual(["bash", "-lc", 'pnpm test "$@"', "test", "-x", "y"]);
    expect((c.args[2] as { workdir: string }).workdir).toBe("/workspace");
    const e = await err(run(t.ctx, "a", "nope", []));
    expect(e?.code).toBe("SCRIPT_NOT_FOUND");
    expect(e?.message).toContain("test");
    expect(e?.message).toContain("lint");
  });
  test("run on absent instance -> NOT_FOUND", async () => {
    const t = setup({ scripts: { s: { run: "x", description: "d" } } });
    expect((await err(run(t.ctx, "zz", "s", [])))?.code).toBe("NOT_FOUND");
  });
  test("shell uses bash -l with tty", async () => {
    const t = setup();
    await created(t);
    await shell(t.ctx, "a");
    const c = t.rt.calls.filter((x) => x.op === "execInteractive").pop()!;
    expect(c.args[1]).toEqual(["bash", "-l"]);
    expect(c.args[2]).toMatchObject({ tty: true, workdir: "/workspace" });
  });
  test("check runs manifest checks", async () => {
    const t = setup({ checks: { web: { run: "curl x" } } });
    await created(t);
    const r = await check(t.ctx, "a");
    expect(r.health).toBe("healthy");
    expect(r.items[0]!.name).toBe("web");
  });
});

describe("tunnel", () => {
  const withEnv = async (env: Record<string, string | undefined>, f: () => Promise<void>) => {
    const keys = ["NO_PROXY", "no_proxy"];
    const old = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    try { await f(); } finally { keys.forEach((k, i) => (old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i]!))); }
  };
  test("socks5h hint always; NO_PROXY and LAN hints conditional", async () => {
    const t = setup();
    await created(t);
    await withEnv({ NO_PROXY: "localhost,127.0.0.1" }, async () => {
      const r = await tunnel(t.ctx, "a");
      expect(r.urls[0]).toMatch(/^socks5h:\/\/127\.0\.0\.1:\d+$/);
      expect(r.urls).toContain(`socks5h://192.168.1.5:${r.port}`);
      expect(r.bind).toBe("0.0.0.0");
      expect(r.auth).toBe(false);
      expect(r.hints.some((h) => h.includes("socks5h://"))).toBe(true);
      expect(r.hints.some((h) => h.includes("NO_PROXY"))).toBe(true);
      expect(r.hints.some((h) => h.includes("LAN without auth"))).toBe(true);
    });
    await withEnv({}, async () => {
      const r = await tunnel(t.ctx, "a");
      expect(r.hints.some((h) => h.includes("NO_PROXY"))).toBe(false);
    });
    await withEnv({ no_proxy: "127.0.0.1" }, async () => {
      expect((await tunnel(t.ctx, "a")).hints.some((h) => h.includes("NO_PROXY"))).toBe(true);
    });
  });
  test("bind 127.0.0.1 with auth: no LAN warning", async () => {
    const t = setup({ socksBind: "127.0.0.1", socksAuth: { user: "u", pass: "p" } });
    await created(t);
    await withEnv({}, async () => {
      const r = await tunnel(t.ctx, "a");
      expect(r.auth).toBe(true);
      expect(r.hints.some((h) => h.includes("LAN"))).toBe(false);
    });
  });
});

describe("open", () => {
  test("uri hex is exact; launches editor when on PATH", async () => {
    const t = setup({ id: "basic" });
    await collect(up(t.ctx, "feat-a", { wait: false }));
    const spawned: string[][] = [];
    const r = await open(t.ctx, "feat-a", undefined, { which: (b) => `/bin/${b}`, spawn: (cmd) => void spawned.push(cmd) });
    expect(r.uri).toBe("vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a222f7774632d62617369632d2d666561742d61227d/workspace");
    expect(r.launched).toBe(true);
    expect(spawned[0]).toEqual(["code", "--folder-uri", r.uri]);
  });
  test("editor from config; not on PATH -> launched false", async () => {
    const t = setup();
    await created(t);
    mkdirSync(join(t.home, ".config", "wtc"), { recursive: true });
    writeFileSync(join(t.home, ".config", "wtc", "config.json"), JSON.stringify({ editor: "cursor" }));
    const spawned: string[][] = [];
    const r = await open(t.ctx, "a", undefined, { which: () => null, spawn: (c) => void spawned.push(c) });
    expect(r.launched).toBe(false);
    expect(spawned).toEqual([]);
    const r2 = await open(t.ctx, "a", undefined, { which: (b) => b, spawn: (c) => void spawned.push(c) });
    expect(r2.launched && spawned[0]![0]).toBe("cursor");
    await open(t.ctx, "a", "code", { which: (b) => b, spawn: (c) => void spawned.push(c) });
    expect(spawned[1]![0]).toBe("code");
  });
});

describe("logs", () => {
  test("latest boot by default; --boot selects; follow tails and aborts", async () => {
    const t = setup();
    await created(t);
    const dir = join(t.dir, ".wtc", "log", "a");
    writeFileSync(join(dir, "init.20260101T000000.log"), "old1\n");
    writeFileSync(join(dir, "init.20260102T000000.log"), "new1\nnew2\n");
    expect(await collect(logs(t.ctx, "a"))).toEqual(["new1", "new2"]);
    expect(await collect(logs(t.ctx, "a", { boot: "20260101T000000" }))).toEqual(["old1"]);
    expect((await err(collect(logs(t.ctx, "a", { boot: "zzz" }))))?.code).toBe("NOT_FOUND");

    const ac = new AbortController();
    const got: string[] = [];
    const p = (async () => {
      for await (const l of logs(t.ctx, "a", { follow: true, signal: ac.signal })) {
        got.push(l);
        if (l === "new3") ac.abort();
      }
    })();
    await Bun.sleep(30);
    writeFileSync(join(dir, "init.20260102T000000.log"), "new1\nnew2\nnew3\n");
    await p;
    expect(got).toEqual(["new1", "new2", "new3"]);
  });
});

describe("gc", () => {
  async function scenario() {
    const t = setup();
    await created(t, "live");
    const hash = await computeImageHash(t.ctx.setup);
    // orphan dirs
    for (const k of ["run", "log"]) mkdirSync(join(t.dir, ".wtc", k, "ghost"), { recursive: true });
    // orphan instance volume + live one + setup-scope
    await t.rt.volumeCreate("wtc-demo--ghost.v.pg", { "wtc.setup": "demo", "wtc.scope": "instance", "wtc.name": "ghost" });
    await t.rt.volumeCreate("wtc-demo--live.v.pg", { "wtc.setup": "demo", "wtc.scope": "instance", "wtc.name": "live" });
    // images
    t.rt.images.push({ ref: "wtc-demo:oldhash", id: "x1" }, { ref: "wtc-demo:usedhash", id: "x2" });
    await t.rt.create({ name: "wtc-demo--other", image: "wtc-demo:usedhash", labels: { "wtc.setup": "demo", "wtc.setupDir": t.dir, "wtc.name": "other" }, env: {}, mounts: [], ports: [], entrypoint: [], extraHosts: [] });
    // logs: 7 logs on live
    const ld = join(t.dir, ".wtc", "log", "live");
    for (let i = 1; i <= 7; i++) writeFileSync(join(ld, `init.2026010${i}.log`), "x");
    return { t, hash };
  }
  test("dry-run reports but does not remove", async () => {
    const { t, hash } = await scenario();
    const before = t.rt.calls.length;
    const r = await gc(t.ctx, { dryRun: true, pruneStore: true });
    const names = r.removed.map((x) => `${x.kind}:${x.name}`);
    expect(names).toContain("dir:run/ghost");
    expect(names).toContain("dir:log/ghost");
    expect(names).toContain("volume:wtc-demo--ghost.v.pg");
    expect(names).toContain("image:wtc-demo:oldhash");
    expect(names).not.toContain("image:wtc-demo:usedhash");
    expect(names).not.toContain(`image:wtc-demo:${hash}`);
    expect(names).not.toContain("volume:wtc-demo--live.v.pg");
    expect(r.removed.filter((x) => x.kind === "log").map((x) => x.name).sort()).toEqual(["log/live/init.20260101.log", "log/live/init.20260102.log"]);
    expect(r.storePruned).toBe(false);
    expect(t.rt.calls.slice(before).map((c) => c.op).filter((o) => ["volumeRm", "imageRm", "runOnce", "rm"].includes(o))).toEqual([]);
    expect(existsSync(join(t.dir, ".wtc", "run", "ghost"))).toBe(true);
  });
  test("real run removes; prune-store runs flock prune", async () => {
    const { t, hash } = await scenario();
    const r = await gc(t.ctx, { pruneStore: true });
    expect(r.storePruned).toBe(true);
    expect(existsSync(join(t.dir, ".wtc", "run", "ghost"))).toBe(false);
    expect(existsSync(join(t.dir, ".wtc", "log", "ghost"))).toBe(false);
    expect(t.rt.volumes.has("wtc-demo--ghost.v.pg")).toBe(false);
    expect(t.rt.volumes.has("wtc-demo--live.v.pg")).toBe(true);
    expect(t.rt.images.map((i) => i.ref).sort()).toEqual([`wtc-demo:${hash}`, "wtc-demo:usedhash"].sort());
    expect(readdirSync(join(t.dir, ".wtc", "log", "live")).length).toBe(5);
    const ro = t.rt.calls.find((c) => c.op === "runOnce")!.args[0] as { image: string; cmd: string[]; mounts: { source: string }[]; env: Record<string, string> };
    expect(ro.image).toBe(`wtc-demo:${hash}`);
    expect(ro.cmd[2]).toBe("flock -x /pnpm/.wtc-lock pnpm store prune");
    expect(ro.mounts[0]!.source).toBe("wtc-demo.pnpm");
    expect(ro.env.PNPM_CONFIG_STORE_DIR).toBe("/pnpm/store");
  });
});

describe("doctor", () => {
  test("reports checks and never throws", async () => {
    const t = setup();
    const r = await doctor(t.ctx);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["runtime", "platform", "setup-dir", "allowBuilds"]));
    expect(r.checks.find((c) => c.name === "runtime")!.ok).toBe(true);
  });
  test("runtime down -> ok false with hint, no throw", async () => {
    const t = setup();
    t.rt.platform = async () => { throw new Error("cannot connect"); };
    const r = await doctor(t.ctx);
    const c = r.checks.find((x) => x.name === "runtime")!;
    expect(c.ok).toBe(false);
    expect(c.hint).toBeTruthy();
  });
  test("colima without forwardAgent flagged; setup dir outside roots flagged; toolchain failure flagged", async () => {
    const t = setup();
    t.rt.platformInfo = { kind: "colima", arch: "arm64", hostGatewayFlag: false, bindableRoots: ["/nonexistent-root"] };
    mkdirSync(join(t.home, ".colima", "default"), { recursive: true });
    writeFileSync(join(t.home, ".colima", "default", "colima.yaml"), "forwardAgent: false\n");
    const hash = await computeImageHash(t.ctx.setup);
    t.rt.images.push({ ref: `wtc-demo:${hash}`, id: "i" });
    t.rt.execHandler = () => ({ exitCode: 1, stdout: "", stderr: "flock: not found" });
    const r = await doctor(t.ctx);
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(by["colima-forwardAgent"]!.ok).toBe(false);
    expect(by["setup-dir"]!.ok).toBe(false);
    expect(by["toolchain"]!.ok).toBe(false);
    expect(by["toolchain"]!.detail).toContain("flock");
  });
});
