import { describe, expect, test } from "bun:test";
import { runChecks } from "../../src/health/health";
import { FakeRuntime } from "../../src/runtime/fake";

async function rtWith(handler?: FakeRuntime["execHandler"]) {
  const rt = new FakeRuntime();
  await rt.create({ name: "c", image: "i", labels: {}, env: {}, mounts: [], ports: [], entrypoint: [], extraHosts: [] });
  await rt.start("c");
  rt.execHandler = handler;
  return rt;
}
const checks = { a: { run: "ok-a", timeout: 5 }, b: { run: "ok-b", timeout: 5 } };

describe("runChecks", () => {
  test("no checks -> unknown", async () => {
    expect(await runChecks(await rtWith(), "c", {}, "/w")).toEqual({ health: "unknown", items: [] });
  });
  test("all ok -> healthy, uses bash -lc and cwd", async () => {
    const rt = await rtWith(() => ({ exitCode: 0, stdout: "fine", stderr: "" }));
    const r = await runChecks(rt, "c", checks, "/w");
    expect(r.health).toBe("healthy");
    expect(r.items.map((i) => i.name)).toEqual(["a", "b"]);
    expect(r.items[0]).toMatchObject({ ok: true, exitCode: 0, output: "fine" });
    const ex = rt.calls.find((x) => x.op === "exec")!;
    expect(ex.args[1]).toEqual(["bash", "-lc", "ok-a"]);
    expect(ex.args[2]).toMatchObject({ workdir: "/w", timeoutMs: 5000 });
  });
  test("mixed -> degraded", async () => {
    const rt = await rtWith((_n, cmd) => ({ exitCode: cmd[2] === "ok-a" ? 0 : 1, stdout: "", stderr: "bad" }));
    const r = await runChecks(rt, "c", checks, "/w");
    expect(r.health).toBe("degraded");
    expect(r.items[1]).toMatchObject({ ok: false, exitCode: 1, output: "bad" });
  });
  test("all fail -> unhealthy", async () => {
    const rt = await rtWith(() => ({ exitCode: 2, stdout: "", stderr: "" }));
    expect((await runChecks(rt, "c", checks, "/w")).health).toBe("unhealthy");
  });
  test("timeout -> exitCode 124", async () => {
    const rt = await rtWith();
    rt.exec = () => new Promise(() => {});
    const r = await runChecks(rt, "c", { slow: { run: "sleep 99", timeout: 0.05 } }, "/w");
    expect(r.health).toBe("unhealthy");
    expect(r.items[0]).toMatchObject({ ok: false, exitCode: 124 });
  });
});
