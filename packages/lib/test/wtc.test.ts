import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWtc } from "../src/wtc";
import { FakeRuntime } from "../src/runtime/fake";
import type { InstanceSummary } from "../src/instance/instance";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-facade-"));
  roots.push(root);
  const dir = join(root, "setup");
  cpSync(join(import.meta.dir, "fixtures", "basic"), dir, { recursive: true });
  return { dir, cacheDir: join(root, "cache") };
}

describe("createWtc", () => {
  test("up/ls/build through the facade", async () => {
    const { dir, cacheDir } = fixture();
    const rt = new FakeRuntime();
    const w = await createWtc({ setupDir: dir, runtime: rt, cacheDir });
    for await (const _ of w.up("a", { wait: false })) { /* drain */ }
    expect((await w.ls()).map((s) => s.name)).toEqual(["a"]);
    expect((await w.build()).skipped).toBe(true);
  });

  test("watch emits on runtime transitions (stop)", async () => {
    const { dir, cacheDir } = fixture();
    const rt = new FakeRuntime();
    const w = await createWtc({ setupDir: dir, runtime: rt, cacheDir });
    for await (const _ of w.up("a", { wait: false })) { /* drain */ }
    const ac = new AbortController();
    const seen: InstanceSummary[] = [];
    const p = (async () => {
      for await (const s of w.watch("a", ac.signal)) {
        seen.push(s);
        if (s.state === "stopped") ac.abort();
      }
    })();
    await Bun.sleep(50);
    await w.stop("a");
    await p;
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]!.state).toBe("stopped");
  });

  test("runtime down: createWtc succeeds and doctor reports a failed runtime check", async () => {
    const { dir, cacheDir } = fixture();
    const rt = new FakeRuntime();
    rt.platform = async () => { throw new Error("cannot connect"); };
    const w = await createWtc({ setupDir: dir, runtime: rt, cacheDir });
    const r = await w.doctor();
    expect(r.checks.find((c) => c.name === "runtime")!.ok).toBe(false);
  });
});
