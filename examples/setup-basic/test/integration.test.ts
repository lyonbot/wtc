/**
 * Real-docker integration tests for examples/setup-basic (spec §14). Gated: WTC_INTEGRATION=1.
 * The setup is copied under $HOME/.cache/wtc-it/ (colima only shares $HOME) with id rewritten to "wtcit";
 * every resource created carries label wtc.setup=wtcit / prefix wtc-wtcit and is removed in afterAll.
 * Set WTC_IT_KEEP_IMAGE=1 to keep the built image between runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as lib from "../../../packages/wtc/src/index";
import { createWtc, DockerCliRuntime, WtcError, type UpEvent, type Wtc } from "../../../packages/wtc/src/index";

const IT = process.env.WTC_INTEGRATION === "1";
const ID = "wtcit";
const MIN = 60_000;

// same virtual module the CLI registers, so the copied wtc.setup.ts can `import { defineSetup } from "@lyonbot/wtc/setup"`
Bun.plugin({ name: "wtc-virtual-it", setup: (b) => { for (const id of ["wtc", "@lyonbot/wtc/setup"]) b.module(id, () => ({ exports: { ...lib }, loader: "object" })); } });

const root = join(homedir(), ".cache", "wtc-it", `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
const rt = new DockerCliRuntime();

/** Copy the example to `root/<sub>` with id "wtcit", a test socks port range and optional manifest extras. */
function copySetup(sub: string, extra = ""): string {
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true });
  cpSync(join(import.meta.dir, ".."), dir, { recursive: true, filter: (s) => !/\/(\.wtc|test|node_modules)$/.test(s) });
  const f = join(dir, "wtc.setup.ts");
  const src = readFileSync(f, "utf8");
  const out = src.replace(`id: "basic",`, `id: "${ID}",\n  socksHostPortRange: [22080, 22179],${extra}`);
  if (out === src) throw new Error("could not rewrite setup id");
  writeFileSync(f, out);
  return dir;
}

async function sh(argv: string[], env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() }) {
  const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** HTTP GET to 127.0.0.1:5173 *inside* the container via its socks port; clean env so no host proxy / NO_PROXY applies. */
const viaSocks = (port: number, path = "/") =>
  sh(["curl", "-sS", "--max-time", "10", "--socks5-hostname", `127.0.0.1:${port}`, `http://127.0.0.1:5173${path}`]);

async function drain(it: AsyncIterable<UpEvent>): Promise<Extract<UpEvent, { type: "done" }>> {
  let done: UpEvent | undefined;
  for await (const e of it) if (e.type === "done") done = e;
  if (!done || done.type !== "done") throw new Error("up ended without done");
  return done;
}

const statusFile = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, ".wtc", "run", name, "status.json"), "utf8"));

async function cleanup() {
  const ids = (await sh(["docker", "ps", "-aq", "--filter", `label=wtc.setup=${ID}`])).stdout.split("\n").filter(Boolean);
  if (ids.length) await sh(["docker", "rm", "-f", ...ids]);
  const vols = (await sh(["docker", "volume", "ls", "-q", "--filter", `label=wtc.setup=${ID}`])).stdout.split("\n").filter(Boolean);
  if (vols.length) await sh(["docker", "volume", "rm", "-f", ...vols]);
  await sh(["docker", "volume", "rm", "-f", `wtc-${ID}.pnpm`]);
}

describe.skipIf(!IT)("setup-basic (real docker)", () => {
  let dir: string;
  let w: Wtc;
  let hostSrv: ReturnType<typeof Bun.listen> | undefined;
  const socks: Record<string, number> = {};

  beforeAll(async () => {
    await cleanup();
    dir = copySetup("main");
    w = await createWtc({ setupDir: dir });
    // hostForwards target: a TCP server on the host at 16379
    hostSrv = Bun.listen({
      hostname: "127.0.0.1",
      port: 16379,
      socket: { open(s) { s.write("pong-from-host\n"); s.end(); }, data() {} },
    });
  });

  afterAll(async () => {
    hostSrv?.stop(true);
    await cleanup();
    if (process.env.WTC_IT_KEEP_IMAGE !== "1") {
      const imgs = (await sh(["docker", "image", "ls", "-q", `wtc-${ID}`])).stdout.split("\n").filter(Boolean);
      if (imgs.length) await sh(["docker", "image", "rm", "-f", ...new Set(imgs)]);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("up a & b concurrently -> both ready", async () => {
    const [a, b] = await Promise.all([drain(w.up("a", {})), drain(w.up("b", { set: { APP_GREETING: "hi" } }))]);
    for (const d of [a, b]) {
      if (d.summary.state !== "ready") console.error(d.logTail?.join("\n"));
      expect(d.summary.state).toBe("ready");
      expect(d.summary.socks?.port).toBeGreaterThanOrEqual(22080);
      socks[d.summary.name] = d.summary.socks!.port;
    }
    expect(socks.a).not.toBe(socks.b);
  }, 15 * MIN);

  test("via SOCKS each instance answers with its own name on the same port 5173", async () => {
    expect((await viaSocks(socks.a!)).stdout).toBe("hello from a\n");
    expect((await viaSocks(socks.b!)).stdout).toBe("hi from b\n");
    const t = await w.tunnel("a");
    expect(t.urls[0]).toBe(`socks5h://127.0.0.1:${socks.a}`);
    if (/localhost|127\.0\.0\.1/.test(`${process.env.NO_PROXY ?? ""},${process.env.no_proxy ?? ""}`))
      expect(t.hints.join("\n")).toContain("NO_PROXY");
  });

  test("run restart-dev-server -> exit 0, still reachable", async () => {
    expect(await w.run("a", "restart-dev-server", [])).toBe(0);
    expect((await viaSocks(socks.a!)).stdout).toBe("hello from a\n");
  }, MIN);

  test("check -> healthy", async () => {
    const r = await w.check("a");
    expect(r.health).toBe("healthy");
    expect(r.items.map((i) => i.name)).toEqual(["http"]);
    expect((await w.status("b")).health).toBe("healthy");
  });

  test("hostForwards: container 127.0.0.1:16379 reaches the host server", async () => {
    const r = await rt.exec(`wtc-${ID}--a`, ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/16379 && head -n1 <&3"]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("pong-from-host\n");
  });

  test("gc --prune-store keeps running instances' dependencies", async () => {
    const r = await w.gc({ pruneStore: true });
    expect(r.storePruned).toBe(true);
    expect(r.removed).toEqual([]);
    // server.mjs requires is-number at startup: a restart proves the store still serves it
    expect(await w.run("b", "restart-dev-server", [])).toBe(0);
    expect((await viaSocks(socks.b!)).stdout).toBe("hi from b\n");
  }, 2 * MIN);

  test("stop/start -> socks port unchanged, ready again", async () => {
    await w.stop("a");
    expect((await w.status("a")).state).toBe("stopped");
    await w.start("a");
    const d = await drain(w.up("a", {}));
    expect(d.summary.state).toBe("ready");
    expect(d.summary.socks?.port).toBe(socks.a!);
    expect((await rt.port(`wtc-${ID}--a`, 1080))?.hostPort).toBe(socks.a!);
    expect((await viaSocks(socks.a!)).stdout).toBe("hello from a\n");
  }, 5 * MIN);

  test("restart -> new bootId, ready again (init is idempotent)", async () => {
    const before = (await w.status("a")).bootId;
    expect(before).toBeTruthy();
    await w.restart("a");
    const d = await drain(w.up("a", {}));
    expect(d.summary.state).toBe("ready");
    expect(d.summary.bootId).toBeTruthy();
    expect(d.summary.bootId).not.toBe(before);
    expect(d.summary.socks?.port).toBe(socks.a!);
    expect((await viaSocks(socks.a!)).stdout).toBe("hello from a\n");
  }, 5 * MIN);

  test("remark: container <-> host, multi-line, survives restart", async () => {
    const inner = (...args: string[]) => rt.exec(`wtc-${ID}--a`, ["/wtc/bin/wtc-remark", ...args]);
    expect((await inner("running", "tests")).exitCode).toBe(0);
    expect(await w.remark("a")).toBe("running tests");
    expect((await w.status("a")).remark).toBe("running tests");
    await w.setRemark("a", "from host\nsecond line");
    expect((await inner()).stdout).toBe("from host\nsecond line\n");
    expect((await w.ls()).find((i) => i.name === "a")?.remark).toBe("from host\nsecond line");
    await w.restart("a");
    expect((await drain(w.up("a", {}))).summary.state).toBe("ready");
    expect(await w.remark("a")).toBe("from host\nsecond line");
    expect((await inner("--clear")).exitCode).toBe(0);
    expect(await w.remark("a")).toBeUndefined();
  }, 5 * MIN);

  test("preRemove veto, then rm --force removes container, instance volumes and state", async () => {
    const c = `wtc-${ID}--a`;
    await rt.exec(c, ["touch", "/workspace/app/.keep"]);
    const err = await w.rm("a", {}).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(WtcError);
    expect((err as WtcError).code).toBe("PREREMOVE_REJECTED");
    expect(await rt.inspect(c)).not.toBeNull();
    expect((await rt.volumeLs({ "wtc.setup": ID })).map((v) => v.name)).toContain(`${c}.v.scratch`);

    await w.rm("a", { force: true });
    expect(await rt.inspect(c)).toBeNull();
    expect((await rt.volumeLs({ "wtc.setup": ID })).map((v) => v.name)).not.toContain(`${c}.v.scratch`);
    expect(existsSync(join(dir, ".wtc", "run", "a"))).toBe(false);
    expect(existsSync(join(dir, ".wtc", "log", "a"))).toBe(false);
    // b untouched, shared pnpm volume kept
    expect((await w.status("b")).state).toBe("ready");
    expect((await rt.volumeLs({ "wtc.setup": ID })).map((v) => v.name)).toContain(`wtc-${ID}.pnpm`);
  }, MIN);

  test("failing init (FAIL_AT=install) -> up done failed with logTail", async () => {
    const d = await drain(w.up("c", { set: { FAIL_AT: "install" } }));
    expect(d.summary.state).toBe("failed");
    expect(d.summary.phase).toBe("install");
    expect(d.logTail?.join("\n")).toContain("FAIL_AT=install: exiting 3");
    const s = statusFile(dir, "c");
    expect(s.exitCode).toBe(3);
    expect(s.reason).toBe("exit");
    // re-up of a failed instance returns failed immediately
    expect((await drain(w.up("c", {}))).summary.state).toBe("failed");
    await w.rm("b", { force: true });
    await w.rm("c", { force: true });
    expect(await w.ls()).toEqual([]);
  }, 5 * MIN);

  test("readyTimeout (linux setsid path): hanging init -> failed/timeout, init processes gone", async () => {
    // separate copy (same id; the main instances are gone, so no SETUP_ID_CONFLICT) with a tiny readyTimeout
    const tdir = copySetup("timeout", "\n  readyTimeout: 3,");
    const tw = await createWtc({ setupDir: tdir });
    const d = await drain(tw.up("t", { set: { FAIL_AT: "hang" } }));
    expect(d.summary.state).toBe("failed");
    const s = statusFile(tdir, "t");
    expect(s.reason).toBe("timeout");
    expect(s.message).toContain("within 3s");
    const ps = await rt.exec(`wtc-${ID}--t`, [
      "bash", "-c", "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f 2>/dev/null; echo; done | grep -c '^sleep 7777' || true",
    ]);
    expect(ps.stdout.trim()).toBe("0");
    expect((await rt.exec(`wtc-${ID}--t`, ["sh", "-c", "command -v setsid"])).exitCode).toBe(0); // the setsid branch was taken
    await tw.rm("t", { force: true });
  }, 5 * MIN);
});
