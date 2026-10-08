import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWtc, FakeRuntime, type UpEvent, type Wtc } from "../../src/index";
import { runCli } from "../../src/cli/main";
import { upRenderer } from "../../src/cli/render";

const tmp = mkdtempSync(join(tmpdir(), "wtc-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function capture(f: () => Promise<number>) {
  const out: string[] = [], err: string[] = [];
  const l = spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const e = spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await f();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    l.mockRestore();
    e.mockRestore();
  }
}

function mkSetup() {
  const dir = mkdtempSync(join(tmp, "s-"));
  cpSync(join(import.meta.dir, "../fixtures/basic/image"), join(dir, "image"), { recursive: true });
  writeFileSync(join(dir, "wtc.setup.ts"), `export default { id: "clitest", scripts: { s: { run: "x", description: "d" } } };\n`);
  return dir;
}

async function withInstance() {
  const rt = new FakeRuntime();
  const w = await createWtc({ setupDir: mkSetup(), runtime: rt, cacheDir: join(tmp, "cache") });
  for await (const _ of w.up("a", { wait: false })) { /* create */ }
  return { rt, load: async () => w };
}

describe("cli in-process", () => {
  test("tunnel prints socks5h urls and NO_PROXY warning", async () => {
    const { load } = await withInstance();
    const old = process.env.NO_PROXY;
    process.env.NO_PROXY = "localhost,127.0.0.1";
    try {
      const r = await capture(() => runCli(["bun", "wtc", "tunnel", "a"], load));
      expect(r.code).toBe(0);
      expect(r.out).toContain("socks5h://127.0.0.1:");
      expect(r.out).toContain("hint: ");
      expect(r.out).toContain("NO_PROXY");
    } finally {
      if (old === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = old;
    }
  });

  test("run passes through the child's exit code", async () => {
    const { rt, load } = await withInstance();
    rt.execHandler = () => ({ exitCode: 3, stdout: "", stderr: "" });
    const r = await capture(() => runCli(["bun", "wtc", "run", "a", "s", "--", "-x"], load));
    expect(r.code).toBe(3);
    const c = rt.calls.filter((x) => x.op === "execInteractive").pop()!;
    expect(c.args[1]).toEqual(["bash", "-lc", 'x "$@"', "s", "-x"]);
  });

  test("run: --host routes to runHost; flags after -- reach the script; --json with a script is a usage error", async () => {
    const { load } = await withInstance();
    const w = await load();
    const calls: unknown[][] = [];
    w.run = async (...a) => { calls.push(["run", ...a]); return 0; };
    w.runHost = async (...a) => { calls.push(["host", ...a]); return 4; };
    expect((await capture(() => runCli(["bun", "wtc", "run", "--host", "a", "h", "--", "x", "y"], load))).code).toBe(4);
    expect((await capture(() => runCli(["bun", "wtc", "run", "a", "s", "--", "--json", "--host", "--foo"], load))).code).toBe(0);
    expect(calls).toEqual([["host", "a", "h", ["x", "y"]], ["run", "a", "s", ["--json", "--host", "--foo"]]]);
    const j = await capture(() => runCli(["bun", "wtc", "run", "a", "s", "--json"], load));
    expect(j.code).toBe(2);
    expect(j.err).toContain("--json only applies to listing");
    expect(calls.length).toBe(2);
  });

  test("run --host on a missing instance: NOT_FOUND with the wtc up hint", async () => {
    const dir = mkSetup();
    writeFileSync(join(dir, "wtc.setup.ts"), `export default { id: "clitest", hostScripts: { h: { run: "true", description: "d" } } };\n`);
    const w = await createWtc({ setupDir: dir, runtime: new FakeRuntime(), cacheDir: join(tmp, "cache") });
    const r = await capture(() => runCli(["bun", "wtc", "run", "--host", "ghost", "h"], async () => w));
    expect(r.code).toBe(1);
    expect(r.err).toContain("instance ghost does not exist");
    expect(r.err).toContain("hint: wtc up ghost");
  });

  test("agent: passes the agent name, args after -- and the exit code through", async () => {
    const { load } = await withInstance();
    const w = await load();
    let got: unknown[] = [];
    w.agent = async (...a) => { got = a; return 5; };
    const custom = await capture(() => runCli(["bun", "wtc", "agent", "a", "claude-custom"], load));
    expect(custom.code).toBe(5);
    expect(got).toEqual(["a", "claude-custom", []]);
    const r = await capture(() => runCli(["bun", "wtc", "agent", "a", "codex", "--", "exec", "-m", "x", "--json"], load));
    expect(r.code).toBe(5);
    expect(got).toEqual(["a", "codex", ["exec", "-m", "x", "--json"]]);
  });

  test("up ending failed: prints log tail + restart hint, exit 1", async () => {
    const summary = { name: "a", container: "c", state: "failed", phase: "install", message: "exit 3", staleImage: false } as const;
    const events: UpEvent[] = [
      { type: "action", action: "create" },
      { type: "status", summary: { ...summary, state: "booting" } },
      { type: "done", summary, logTail: ["boom line 1", "boom line 2"] },
    ];
    const stub = { up: async function* () { yield* events; } } as unknown as Wtc;
    const r = await capture(() => runCli(["bun", "wtc", "up", "a"], async () => stub));
    expect(r.code).toBe(1);
    expect(r.out).toContain("▸ create");
    expect(r.out).toContain("▸ phase install");
    expect(r.out).toContain("✖ failed");
    expect(r.out).toContain("boom line 2");
    expect(r.out).toContain("hint: wtc restart a");
  });

  test("gc prints removed items, per-item failures and the store prune error; exit 1 (also with --json)", async () => {
    const res = {
      removed: [{ kind: "dir", name: "run/x" }],
      failed: [{ kind: "image", name: "wtc-s:old", error: "image is in use" }],
      storePruned: false, store: "failed", storeError: "ERR_PNPM_X boom",
    };
    const stub = { gc: async () => res } as unknown as Wtc;
    const r = await capture(() => runCli(["bun", "wtc", "gc", "--prune-store"], async () => stub));
    expect(r.code).toBe(1);
    expect(r.out).toContain("removed dir run/x");
    expect(r.err).toContain("failed to remove image wtc-s:old: image is in use");
    expect(r.err).toContain("pnpm store prune failed");
    expect(r.err).toContain("  | ERR_PNPM_X boom");
    expect(r.out).not.toContain("nothing to clean");
    const j = await capture(() => runCli(["bun", "wtc", "gc", "--json"], async () => ({ gc: async () => ({ ...res, store: undefined, storeError: undefined }) }) as unknown as Wtc));
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out).failed).toHaveLength(1);
    const ok = await capture(() => runCli(["bun", "wtc", "gc"], async () => ({ gc: async () => ({ removed: [], failed: [], storePruned: false }) }) as unknown as Wtc));
    expect(ok).toMatchObject({ code: 0, out: "nothing to clean" });
  });

  test("upRenderer: one line per phase change", () => {
    const r = upRenderer("a");
    const st = (phase: string): UpEvent => ({ type: "status", summary: { name: "a", container: "c", state: "booting", phase, staleImage: false } });
    expect(r(st("install"))).toEqual(["▸ phase install"]);
    expect(r(st("install"))).toEqual([]);
    expect(r(st("build"))).toEqual(["▸ phase build"]);
  });
});
