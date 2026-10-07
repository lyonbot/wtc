import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCreateSpec } from "../../src/instance/create-spec";
import type { PlatformInfo } from "../../src/runtime/types";
import { mkCtx } from "./helpers";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));
const linux: PlatformInfo = { kind: "linux", arch: "amd64", hostGatewayFlag: true, sshAgentSource: "/tmp/agent.sock" };

function build(m: Parameters<typeof mkCtx>[0] = {}, platform: PlatformInfo = linux, params: Record<string, string> = { BRANCH: "main" }) {
  const t = mkCtx(m);
  cleanups.push(t.cleanup);
  const spec = buildCreateSpec({ ctx: t.ctx, name: "feat-a", imageRef: "wtc-demo:abc", params, socksHostPort: 21080, socksBind: "0.0.0.0", platform });
  return { ...t, spec };
}

describe("buildCreateSpec", () => {
  test("env = params + WTC_*", () => {
    const { spec } = build({ hostForwards: [3306, 6379], readyTimeout: 120, init: "boot.sh", cwd: "/src" });
    expect(spec.env).toEqual({
      BRANCH: "main",
      WTC_SETUP_ID: "demo",
      WTC_NAME: "feat-a",
      WTC_CWD: "/src",
      WTC_INIT: "boot.sh",
      WTC_READY_TIMEOUT: "120",
      WTC_SOCKS_PORT: "1080",
      WTC_HOST_FORWARDS: "3306,6379",
    });
    expect(build().spec.env.WTC_HOST_FORWARDS).toBe("");
    const auth = build({ socksAuth: { user: "u", pass: "p" } }).spec.env;
    expect(auth.WTC_SOCKS_USER).toBe("u");
    expect(auth.WTC_SOCKS_PASS).toBe("p");
  });
  test("name, image, labels, ports, entrypoint", () => {
    const { spec, dir } = build();
    expect(spec.name).toBe("wtc-demo--feat-a");
    expect(spec.image).toBe("wtc-demo:abc");
    expect(spec.labels).toEqual({ "wtc.setup": "demo", "wtc.setupDir": dir, "wtc.name": "feat-a", "wtc.protocol": "1", "wtc.socksHostPort": "21080" });
    expect(spec.ports).toEqual([{ hostIp: "0.0.0.0", hostPort: 21080, containerPort: 1080 }]);
    expect(spec.entrypoint).toEqual(["/wtc/bin/wtc-entry"]);
  });
  test("mounts per §6.1 plus manifest mounts", () => {
    const { spec, dir, home, ctx } = build({
      mounts: [
        { type: "volume", name: "m2", target: "/root/.m2", scope: "setup" },
        { type: "volume", name: "pg", target: "/var/lib/pg", scope: "instance" },
        { type: "volume", external: "shared-models", target: "/models", readonly: true },
        { type: "bind", source: "data", target: "/data", readonly: true },
      ],
    });
    const run = join(dir, ".wtc", "run", "feat-a");
    const byTarget = Object.fromEntries(spec.mounts.map((m) => [m.target, m]));
    expect(byTarget["/pnpm"]).toEqual({ type: "volume", source: "wtc-demo.pnpm", target: "/pnpm" });
    expect(byTarget["/wtc/bin"]).toEqual({ type: "bind", source: ctx.kitDir, target: "/wtc/bin", readonly: true });
    expect(byTarget["/wtc/setup"]).toEqual({ type: "bind", source: dir, target: "/wtc/setup", readonly: true });
    expect(byTarget["/wtc/ssh"]).toEqual({ type: "bind", source: join(run, "ssh"), target: "/wtc/ssh", readonly: true });
    expect(byTarget["/wtc/ssh-agent.sock"]).toEqual({ type: "bind", source: "/tmp/agent.sock", target: "/wtc/ssh-agent.sock", createMissing: true });
    expect(byTarget["/wtc/run"]).toEqual({ type: "bind", source: run, target: "/wtc/run" });
    expect(byTarget["/wtc/log"]).toEqual({ type: "bind", source: join(dir, ".wtc", "log", "feat-a"), target: "/wtc/log" });
    expect(byTarget["/root/.m2"]).toEqual({ type: "volume", source: "wtc-demo.v.m2", target: "/root/.m2" });
    expect(byTarget["/var/lib/pg"]).toEqual({ type: "volume", source: "wtc-demo--feat-a.v.pg", target: "/var/lib/pg" });
    expect(byTarget["/models"]).toEqual({ type: "volume", source: "shared-models", target: "/models", readonly: true });
    expect(byTarget["/data"]).toEqual({ type: "bind", source: join(dir, "data"), target: "/data", readonly: true });
    expect(spec.mounts.length).toBe(11);
    void home;
  });
  test("~ in bind source expands to ctx.home", () => {
    const t = mkCtx();
    cleanups.push(t.cleanup);
    t.ctx.setup.manifest.mounts = [{ type: "bind", source: "~/datasets", target: "/d" }];
    const spec = buildCreateSpec({ ctx: t.ctx, name: "a", imageRef: "i", params: {}, socksHostPort: 1, socksBind: "127.0.0.1", platform: linux });
    expect(spec.mounts.find((m) => m.target === "/d")!.source).toBe(join(t.home, "datasets"));
  });
  test("ssh-agent mount only when platform.sshAgentSource; extraHosts only with hostGatewayFlag", () => {
    const { spec } = build({}, { kind: "other", arch: "arm64", hostGatewayFlag: false });
    expect(spec.mounts.some((m) => m.target === "/wtc/ssh-agent.sock")).toBe(false);
    expect(spec.extraHosts).toEqual([]);
    expect(build().spec.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
  });
  test("bind sources outside bindableRoots -> BIND_NOT_SHARED listing the path", () => {
    const t = mkCtx({ mounts: [{ type: "bind", source: "/opt/elsewhere", target: "/e" }] });
    cleanups.push(t.cleanup);
    const colima: PlatformInfo = { kind: "colima", arch: "arm64", hostGatewayFlag: false, sshAgentSource: "/run/host-services/ssh-auth.sock", bindableRoots: [t.home] };
    let e: { code: string; message: string } | undefined;
    try {
      buildCreateSpec({ ctx: t.ctx, name: "a", imageRef: "i", params: {}, socksHostPort: 1, socksBind: "0.0.0.0", platform: colima });
    } catch (x) { e = x as typeof e; }
    expect(e?.code).toBe("BIND_NOT_SHARED");
    expect(e?.message).toContain("/opt/elsewhere");
    expect(e?.message).toContain(t.dir); // setup dir (tmpdir) is outside home too
    expect(e?.message).not.toContain("ssh-auth.sock"); // agent socket lives in the VM, exempt
    // all under home -> ok
    t.ctx.setup.manifest.mounts = [];
    t.ctx.setup.dir = join(t.home, "setup");
    expect(() => buildCreateSpec({ ctx: t.ctx, name: "a", imageRef: "i", params: {}, socksHostPort: 1, socksBind: "0.0.0.0", platform: colima })).not.toThrow();
  });
});
