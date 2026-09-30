import { expect, test } from "bun:test";
import { DockerCliRuntime } from "../../src/runtime/docker-cli";

type R = { exitCode: number; stdout: string; stderr: string };
function mk(reply: (argv: string[]) => Partial<R> = () => ({})) {
  const calls: string[][] = [];
  const rt = new DockerCliRuntime({
    spawn: async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "", ...reply(argv) };
    },
  });
  return { rt, calls };
}
const has = (argv: string[], ...seq: string[]) =>
  argv.some((_, i) => seq.every((s, j) => argv[i + j] === s));

test("create argv", async () => {
  const { rt, calls } = mk();
  await rt.create({
    name: "wtc-s--a", image: "wtc-s:abc", labels: { "wtc.setup": "s" }, env: { A: "1" },
    mounts: [
      { type: "volume", source: "vol", target: "/pnpm" },
      { type: "bind", source: "/home/x/kit", target: "/wtc/bin", readonly: true },
      { type: "bind", source: "/run/host-services/ssh-auth.sock", target: "/wtc/ssh-agent.sock", createMissing: true },
    ],
    ports: [{ hostIp: "0.0.0.0", hostPort: 21080, containerPort: 1080 }],
    entrypoint: ["/wtc/bin/wtc-entry", "--x"], extraHosts: ["host.docker.internal:host-gateway"], workdir: "/workspace",
  });
  const a = calls[0]!;
  expect(a.slice(0, 2)).toEqual(["docker", "create"]);
  expect(a).toContain("--init");
  expect(has(a, "--restart", "unless-stopped")).toBe(true);
  expect(has(a, "--name", "wtc-s--a")).toBe(true);
  expect(has(a, "-p", "0.0.0.0:21080:1080")).toBe(true);
  expect(has(a, "--mount", "type=volume,src=vol,dst=/pnpm")).toBe(true);
  expect(has(a, "--mount", "type=bind,src=/home/x/kit,dst=/wtc/bin,readonly")).toBe(true);
  // missing-tolerant bind (ssh agent socket) uses -v, which docker auto-creates
  expect(has(a, "-v", "/run/host-services/ssh-auth.sock:/wtc/ssh-agent.sock")).toBe(true);
  expect(a.some((x) => x.includes("dst=/wtc/ssh-agent.sock"))).toBe(false);
  expect(has(a, "--entrypoint", "/wtc/bin/wtc-entry")).toBe(true);
  expect(has(a, "--add-host", "host.docker.internal:host-gateway")).toBe(true);
  expect(has(a, "-l", "wtc.setup=s")).toBe(true);
  expect(has(a, "-e", "A=1")).toBe(true);
  expect(has(a, "-w", "/workspace")).toBe(true);
  // image then entrypoint args last
  expect(a.slice(-2)).toEqual(["wtc-s:abc", "--x"]);
});

test("start maps port errors", async () => {
  for (const msg of ["Bind for 0.0.0.0:21080 failed: port is already allocated", "listen tcp: address already in use"]) {
    const { rt } = mk(() => ({ exitCode: 1, stderr: msg }));
    await expect(rt.start("x")).rejects.toMatchObject({ code: "PORT_IN_USE" });
  }
  const { rt } = mk(() => ({ exitCode: 1, stderr: "boom" }));
  await expect(rt.start("x")).rejects.toMatchObject({ code: "RUNTIME_ERROR", message: "boom" });
});

test("daemon unreachable", async () => {
  const { rt } = mk(() => ({ exitCode: 1, stderr: "Cannot connect to the Docker daemon at unix:///x" }));
  await expect(rt.stop("x")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", hint: expect.stringContaining("wtc doctor") });
});

test("inspect: null on no such object, parses otherwise", async () => {
  const none = mk(() => ({ exitCode: 1, stderr: "Error: No such object: x" }));
  expect(await none.rt.inspect("x")).toBeNull();
  const ok = mk(() => ({
    stdout: JSON.stringify({ Id: "abc", Name: "/x", Config: { Image: "img", Labels: { a: "b" } }, State: { Status: "running", StartedAt: "2026-01-01T00:00:00Z" } }),
  }));
  expect(await ok.rt.inspect("x")).toEqual({ id: "abc", name: "x", image: "img", labels: { a: "b" }, state: "running", startedAt: "2026-01-01T00:00:00Z" });
  const never = mk(() => ({
    stdout: JSON.stringify({ Id: "abc", Name: "/x", Config: { Image: "img", Labels: null }, State: { Status: "created", StartedAt: "0001-01-01T00:00:00Z" } }),
  }));
  expect((await never.rt.inspect("x"))!.startedAt).toBe("");
});

test("ps: label filters, empty => wtc.setup key", async () => {
  const insp = JSON.stringify({ Id: "abc", Name: "/x", Config: { Image: "img", Labels: {} }, State: { Status: "exited", StartedAt: "" } });
  const m = mk((argv) => (argv[1] === "ps" ? { stdout: "abc\n" } : { stdout: insp + "\n" }));
  expect(await m.rt.ps({})).toHaveLength(1);
  expect(m.calls[0]).toEqual(["docker", "ps", "-a", "-q", "--no-trunc", "--filter", "label=wtc.setup"]);
  await m.rt.ps({ "wtc.setup": "s", "wtc.name": "n" });
  expect(m.calls[2]).toEqual(["docker", "ps", "-a", "-q", "--no-trunc", "--filter", "label=wtc.setup=s", "--filter", "label=wtc.name=n"]);
  const empty = mk();
  expect(await empty.rt.ps({})).toEqual([]);
  expect(empty.calls).toHaveLength(1);
});

test("port parsing", async () => {
  const m = mk(() => ({ stdout: "0.0.0.0:21080\n[::]:21080\n" }));
  expect(await m.rt.port("x", 1080)).toEqual({ hostIp: "0.0.0.0", hostPort: 21080 });
  expect(m.calls[0]).toEqual(["docker", "port", "x", "1080/tcp"]);
  const none = mk(() => ({ exitCode: 1, stderr: "Error: No public port '1080/tcp' published for x" }));
  expect(await none.rt.port("x", 1080)).toBeNull();
});

test("platform: colima / linux", async () => {
  const c = new DockerCliRuntime({
    spawn: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ Name: "colima", OperatingSystem: "Ubuntu 24.04", Architecture: "aarch64" }) }),
    hostPlatform: "darwin", home: "/Users/u",
  });
  expect(await c.platform()).toEqual({ kind: "colima", arch: "arm64", sshAgentSource: "/run/host-services/ssh-auth.sock", hostGatewayFlag: false, bindableRoots: ["/Users/u"] });
  const l = new DockerCliRuntime({
    spawn: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ Name: "box", OperatingSystem: "Debian", Architecture: "x86_64" }) }),
    hostPlatform: "linux", env: { SSH_AUTH_SOCK: "/tmp/agent" },
  });
  expect(await l.platform()).toEqual({ kind: "linux", arch: "amd64", sshAgentSource: "/tmp/agent", hostGatewayFlag: true });
});

test("misc argv", async () => {
  const m = mk();
  await m.rt.stop("x", 5); await m.rt.restart("x"); await m.rt.rm("x", true);
  await m.rt.exec("x", ["ls"], { env: { A: "1" }, workdir: "/w" });
  await m.rt.volumeCreate("v", { k: "v" });
  await m.rt.runOnce({ image: "i", cmd: ["c"], mounts: [{ type: "bind", source: "/h", target: "/t", readonly: true }], env: { E: "1" } });
  expect(m.calls[0]).toEqual(["docker", "stop", "-t", "5", "x"]);
  expect(m.calls[1]).toEqual(["docker", "restart", "x"]);
  expect(m.calls[2]).toEqual(["docker", "rm", "-f", "x"]);
  expect(m.calls[3]).toEqual(["docker", "exec", "-e", "A=1", "-w", "/w", "x", "ls"]);
  expect(m.calls[4]).toEqual(["docker", "volume", "create", "--label", "k=v", "v"]);
  expect(m.calls[5]).toEqual(["docker", "run", "--rm", "-e", "E=1", "--mount", "type=bind,src=/h,dst=/t,readonly", "i", "c"]);
});
