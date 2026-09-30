import { expect, test } from "bun:test";
import { WtcError } from "../../src/errors";
import { FakeRuntime } from "../../src/runtime/fake";
import type { CreateSpec } from "../../src/runtime/types";

const spec = (name: string, labels: Record<string, string> = {}): CreateSpec => ({
  name, image: "img", labels, env: {}, mounts: [],
  ports: [{ hostIp: "0.0.0.0", hostPort: 21080, containerPort: 1080 }],
  entrypoint: ["/wtc/bin/wtc-entry"], extraHosts: [],
});

test("lifecycle with injected clock", async () => {
  const rt = new FakeRuntime({ now: () => "2026-01-01T00:00:00.000Z" });
  await rt.create(spec("a"));
  expect((await rt.inspect("a"))!.state).toBe("created");
  expect((await rt.inspect("a"))!.startedAt).toBe("");
  await rt.start("a");
  const i = (await rt.inspect("a"))!;
  expect(i.state).toBe("running");
  expect(i.startedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(await rt.port("a", 1080)).toEqual({ hostIp: "0.0.0.0", hostPort: 21080 });
  await rt.stop("a");
  expect((await rt.inspect("a"))!.state).toBe("exited");
  await rt.rm("a");
  expect(await rt.inspect("a")).toBeNull();
  expect(rt.calls.map((c) => c.op)).toContain("start");
});

test("failNextStart throws once", async () => {
  const rt = new FakeRuntime();
  await rt.create(spec("a"));
  rt.failNextStart = new WtcError("PORT_IN_USE", "x");
  await expect(rt.start("a")).rejects.toMatchObject({ code: "PORT_IN_USE" });
  await rt.start("a");
});

test("ps filters by labels; empty = all wtc.setup containers", async () => {
  const rt = new FakeRuntime();
  await rt.create(spec("a", { "wtc.setup": "s1" }));
  await rt.create(spec("b", { "wtc.setup": "s2" }));
  await rt.create(spec("c", {}));
  expect((await rt.ps({ "wtc.setup": "s1" })).map((c) => c.name)).toEqual(["a"]);
  expect((await rt.ps({})).map((c) => c.name).sort()).toEqual(["a", "b"]);
});

test("execHandler and volumes", async () => {
  const rt = new FakeRuntime();
  await rt.create(spec("a"));
  rt.execHandler = (_n, cmd) => ({ exitCode: 3, stdout: cmd.join(" "), stderr: "" });
  expect(await rt.exec("a", ["x", "y"])).toEqual({ exitCode: 3, stdout: "x y", stderr: "" });
  await rt.volumeCreate("v1", { "wtc.setup": "s" });
  await rt.volumeCreate("v2", { "wtc.setup": "t" });
  expect((await rt.volumeLs({ "wtc.setup": "s" })).map((v) => v.name)).toEqual(["v1"]);
  await rt.volumeRm("v1");
  expect(await rt.volumeLs({})).toHaveLength(1);
});
