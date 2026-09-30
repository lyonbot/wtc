import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kitDir = join(import.meta.dir, "..");
let root: string;
let bin: string;
const procs: Bun.Subprocess[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "wtc-entry-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  for (const f of ["wtc-entry", "wtc-signal", "wtc-install"]) symlinkSync(join(kitDir, "bin", f), join(bin, f));
  const r = Bun.spawnSync(["go", "build", "-o", join(bin, "wtc-kit"), "."], { cwd: join(kitDir, "go") });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
});

afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

interface Boot {
  run: string;
  log: string;
  proc: Bun.Subprocess;
  status: () => any;
  waitDone: () => Promise<any>;
}

function boot(script: string | null, extra: Record<string, string> = {}): Boot {
  const d = mkdtempSync(join(root, "case-"));
  const setup = join(d, "setup");
  const run = join(d, "run");
  const log = join(d, "log");
  mkdirSync(setup);
  if (script !== null) {
    writeFileSync(join(setup, "init.sh"), `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(join(setup, "init.sh"), 0o755);
  }
  const proc = Bun.spawn([join(bin, "wtc-entry")], {
    env: {
      ...process.env,
      HOME: d,
      WTC_BIN: bin,
      WTC_RUN: run,
      WTC_LOG: log,
      WTC_SETUP_MOUNT: setup,
      WTC_SSH: join(d, "nossh"),
      WTC_INIT: "init.sh",
      WTC_CWD: d,
      WTC_SOCKS_PORT: String(freePort()),
      WTC_HOST_FORWARDS: "",
      WTC_READY_TIMEOUT: "30",
      ...extra,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(proc);
  const status = () => {
    try {
      return JSON.parse(readFileSync(join(run, "status.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const waitDone = async () => {
    for (let i = 0; i < 200; i++) {
      const s = status();
      if (s && s.state !== "booting") return s;
      await Bun.sleep(100);
    }
    throw new Error("timeout waiting for status: " + JSON.stringify(status()));
  };
  return { run, log, proc, status, waitDone };
}

describe("wtc-entry", () => {
  test("init exit 0 -> ready, log has init output", async () => {
    const b = boot(`echo hello-from-init\nwtc-signal phase clone`);
    const s = await b.waitDone();
    expect(s.state).toBe("ready");
    expect(s.phase).toBe("clone");
    expect(s.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const logs = readdirSync(b.log);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(`init.${s.bootId}`);
    expect(readFileSync(join(b.log, logs[0]!), "utf8")).toContain("hello-from-init");
    expect(b.proc.exitCode).toBeNull(); // stays resident
  });

  test("init exit 3 -> failed with exitCode and last phase", async () => {
    const b = boot(`wtc-signal phase clone\nwtc-signal phase install "with msg"\nexit 3`);
    const s = await b.waitDone();
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(3);
    expect(s.reason).toBe("exit");
    expect(s.phase).toBe("install");
  });

  test("timeout -> failed reason timeout and init is gone", async () => {
    const marker = `7${Math.floor(Math.random() * 1e6)}`; // unique sleep duration, greppable in ps
    const b = boot(`sleep ${marker}`, { WTC_READY_TIMEOUT: "1" });
    const s = await b.waitDone();
    expect(s.state).toBe("failed");
    expect(s.reason).toBe("timeout");
    const ps = Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString();
    expect(ps).not.toContain(marker);
  });

  test("missing init -> failed with message", async () => {
    const b = boot(null);
    const s = await b.waitDone();
    expect(s.state).toBe("failed");
    expect(s.message).toContain("init script not found or not executable");
  });

  test("SIGTERM exits promptly", async () => {
    const b = boot(`exit 0`);
    await b.waitDone();
    const t = Date.now();
    b.proc.kill("SIGTERM");
    const code = await b.proc.exited;
    expect(code).toBe(0);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test("SIGTERM during init kills init group", async () => {
    const marker = `7${Math.floor(Math.random() * 1e6)}`; // unique sleep duration, greppable in ps
    const b = boot(`wtc-signal phase start\nsleep ${marker}`);
    for (let i = 0; i < 50 && b.status()?.phase !== "start"; i++) await Bun.sleep(100);
    await Bun.sleep(300);
    b.proc.kill("SIGTERM");
    expect(await b.proc.exited).toBe(0);
    await Bun.sleep(200);
    expect(Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString()).not.toContain(marker);
  });

  test("socks listener is served", async () => {
    const port = freePort();
    const b = boot(`exit 0`, { WTC_SOCKS_PORT: String(port) });
    await b.waitDone();
    const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    sock.end();
    expect(existsSync(join(b.run, "status.json"))).toBe(true);
  });
});
