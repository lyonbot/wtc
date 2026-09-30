import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DockerCliRuntime } from "../../src/runtime/docker-cli";

const run = process.env.WTC_INTEGRATION === "1" ? test : test.skip;
const NAME = "wtc-wtcit--rt";
const VOL = "wtc-wtcit--rt.v.data";
const rt = new DockerCliRuntime();
let dir = "";

async function cleanup() {
  await rt.rm(NAME, true).catch(() => {});
  await rt.volumeRm(VOL).catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
}
beforeAll(async () => {
  if (process.env.WTC_INTEGRATION !== "1") return;
  await cleanup();
  dir = mkdtempSync(join(homedir(), ".wtcit-")); // colima only shares $HOME
  writeFileSync(join(dir, "hello.txt"), "hi");
});
afterAll(cleanup);

run("platform", async () => {
  const p = await rt.platform();
  expect(["linux", "colima", "other"]).toContain(p.kind);
  expect(["amd64", "arm64"]).toContain(p.arch);
});

run("container lifecycle", async () => {
  await rt.volumeCreate(VOL, { "wtc.setup": "wtcit", "wtc.scope": "instance" });
  expect((await rt.volumeLs({ "wtc.setup": "wtcit" })).map((v) => v.name)).toContain(VOL);
  await rt.create({
    name: NAME, image: "alpine:3.22", labels: { "wtc.setup": "wtcit", "wtc.name": "rt" }, env: { FOO: "bar" },
    mounts: [
      { type: "volume", source: VOL, target: "/data" },
      { type: "bind", source: dir, target: "/host", readonly: true },
    ],
    ports: [{ hostIp: "127.0.0.1", hostPort: 0, containerPort: 1080 }],
    entrypoint: ["sleep", "3600"], extraHosts: [], workdir: "/data",
  });
  expect((await rt.inspect(NAME))!.state).toBe("created");
  await rt.start(NAME);
  const i = (await rt.inspect(NAME))!;
  expect(i.state).toBe("running");
  expect(i.startedAt).not.toBe("");
  expect(i.labels["wtc.name"]).toBe("rt");
  const port = await rt.port(NAME, 1080);
  expect(port?.hostIp).toBe("127.0.0.1");
  expect(port!.hostPort).toBeGreaterThan(0);
  const r = await rt.exec(NAME, ["sh", "-c", "echo $FOO $(pwd) $(cat /host/hello.txt)"], { env: { FOO: "baz" } });
  expect(r).toEqual({ exitCode: 0, stdout: "baz /data hi\n", stderr: "" });
  expect((await rt.exec(NAME, ["sh", "-c", "exit 7"])).exitCode).toBe(7);
  expect((await rt.ps({})).map((c) => c.name)).toContain(NAME);
  expect((await rt.ps({ "wtc.name": "rt" })).map((c) => c.name)).toEqual([NAME]);
  await rt.stop(NAME, 1);
  expect((await rt.inspect(NAME))!.state).toBe("exited");
  await rt.rm(NAME);
  expect(await rt.inspect(NAME)).toBeNull();
  await rt.volumeRm(VOL);
});

run("runOnce", async () => {
  const r = await rt.runOnce({ image: "alpine:3.22", cmd: ["cat", "/h/hello.txt"], mounts: [{ type: "bind", source: dir, target: "/h", readonly: true }] });
  expect(r.stdout).toBe("hi");
});
