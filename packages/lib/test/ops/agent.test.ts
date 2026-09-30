import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../../src/instance/instance";
import { agent, agentArgv, agentEnv } from "../../src/ops/agent";
import type { HostEnv } from "../../src/agent/host";
import type { ExecOpts, ExecResult } from "../../src/runtime/types";
import type { ManifestInput } from "../../src/setup/schema";
import { collect, err, manifest, mkCtx } from "../instance/helpers";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

/** Instance "a" plus a host with Claude + Codex logins; `probe` lists what exists in the container. */
async function setup(m: Partial<ManifestInput> = {}, probe = { claude: 1, codex: 1, npm: 1, tar: 1, node: 1, ps: 1 } as Record<string, number>) {
  const t = mkCtx(m);
  cleanups.push(t.cleanup);
  await collect(up(t.ctx, "a", { wait: false }));
  const hostHome = join(t.home, "host");
  mkdirSync(join(hostHome, ".claude"), { recursive: true });
  mkdirSync(join(hostHome, ".codex"), { recursive: true });
  writeFileSync(join(hostHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
  writeFileSync(join(hostHome, ".codex", "auth.json"), "{}");
  const host: HostEnv = { home: hostHome, env: { GH: "tok" }, platform: "linux", readKeychain: async () => null };
  const execs: { cmd: string[]; o?: ExecOpts }[] = [];
  const responses: ((cmd: string[]) => ExecResult | undefined)[] = [];
  t.rt.execHandler = (_n, cmd, o) => {
    execs.push({ cmd, o });
    const script = cmd[2] ?? "";
    for (const r of responses) {
      const x = r(cmd);
      if (x) return x;
    }
    if (script.includes("command -v \"$c\"")) {
      const bin = /for c in (\S+) /.exec(script)![1]!;
      const lines = ["/root", ...[bin, "npm", "tar", "node", "ps"].map((c) => `${c}=${probe[c] ?? 0}`)];
      return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const logs: string[] = [];
  const run = (kind: "claude" | "codex", args: string[] = []) => agent(t.ctx, "a", kind, args, { host, log: (l) => logs.push(l) });
  return { ...t, host, execs, responses, logs, run };
}
const last = (t: Awaited<ReturnType<typeof setup>>) => t.rt.calls.filter((c) => c.op === "execInteractive").pop();

describe("agentEnv / agentArgv", () => {
  test("built-ins, literal override, fromHost, null drops", () => {
    const cfg = manifest({ agents: { claude: { env: { A: "1", T: { fromHost: "GH" }, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null } } } }).agents.claude;
    expect(agentEnv("claude", cfg, { GH: "tok" })).toEqual({ IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", A: "1", T: "tok" });
    const e = (() => { try { agentEnv("claude", cfg, {}); } catch (x) { return x as { code: string }; } })();
    expect(e?.code).toBe("AGENT_ENV_MISSING");
    expect(agentEnv("codex", manifest().agents.codex, {})).toEqual({});
  });
  test("argv order: built-in, manifest, CLI", () => {
    const m = manifest({ agents: { codex: { args: ["-m", "x"] } } });
    expect(agentArgv("codex", m.agents.codex, ["exec", "hi"])).toEqual([
      "bash", "-lc", 'exec codex "$@"', "codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "x", "exec", "hi",
    ]);
    expect(agentArgv("claude", m.agents.claude, ["-p", "x"])).toEqual(["bash", "-lc", 'exec claude "$@"', "claude", "--dangerously-skip-permissions", "-p", "x"]);
  });
});

describe("agent", () => {
  test("installed: probe, sync tar via stdin, launch in cwd with env; exit code passes through", async () => {
    const t = await setup({ cwd: "/workspace/app", agents: { claude: { env: { T: { fromHost: "GH" } } } } });
    t.responses.push((cmd) => (cmd[2]?.startsWith("exec claude") ? { exitCode: 7, stdout: "", stderr: "" } : undefined));
    expect(await t.run("claude", ["-p", "hi"])).toBe(7);
    const sync = t.execs.find((e) => e.o?.input)!;
    expect(sync.cmd[2]).toContain('tar -x -C "$HOME"');
    expect(sync.cmd[2]).toContain("node -e");
    expect(sync.o!.input!.length).toBeGreaterThan(0);
    expect(t.execs.some((e) => e.cmd[2]?.includes("npm i -g"))).toBe(false);
    const c = last(t)!;
    expect(c.args[0]).toBe("wtc-demo--a");
    expect((c.args[1] as string[]).slice(-3)).toEqual(["--dangerously-skip-permissions", "-p", "hi"]);
    expect(c.args[2]).toMatchObject({ workdir: "/workspace/app", env: { IS_SANDBOX: "1", T: "tok" } });
  });

  test("codex sync has no .claude.json merge; --no-daemon only when ps is missing", async () => {
    const t = await setup();
    await t.run("codex", ["exec", "x"]);
    const sync = t.execs.find((e) => e.o?.input)!;
    expect(sync.cmd[2]).not.toContain("node -e");
    expect(last(t)!.args[1] as string[]).not.toContain("--no-daemon");
    const t2 = await setup({}, { codex: 1, tar: 1 });
    await t2.run("codex", ["exec", "x"]);
    expect((last(t2)!.args[1] as string[]).slice(4)).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--no-daemon", "exec", "x"]);
  });

  test("missing bin: npm install with version under flock, logs progress", async () => {
    const t = await setup({ agents: { codex: { version: "0.1.2" } } }, { tar: 1, npm: 1 });
    await t.run("codex");
    const inst = t.execs.find((e) => e.cmd[2]?.includes("npm i -g"))!;
    expect(inst.cmd[2]).toContain("flock /tmp/wtc-agent-install.lock");
    expect(inst.cmd.slice(-2)).toEqual(["codex", "@openai/codex@0.1.2"]);
    expect(inst.o?.onLine).toBeDefined();
    expect(t.logs[0]).toContain("installing @openai/codex@0.1.2");
  });

  test("install failure and missing npm -> AGENT_INSTALL_FAILED", async () => {
    const t = await setup({}, { tar: 1, npm: 1 });
    t.responses.push((cmd) => (cmd[2]?.includes("npm i -g") ? { exitCode: 1, stdout: "", stderr: "E404 not found" } : undefined));
    const e = await err(t.run("claude"));
    expect(e?.code).toBe("AGENT_INSTALL_FAILED");
    expect(e?.message).toContain("E404");
    const t2 = await setup({}, { tar: 1 });
    expect((await err(t2.run("claude")))?.code).toBe("AGENT_INSTALL_FAILED");
  });

  test("no tar -> AGENT_IMAGE_UNSUPPORTED; failed sync -> AGENT_SYNC_FAILED; no login -> AGENT_NO_CREDENTIALS before install", async () => {
    const t = await setup({}, { claude: 1 });
    expect((await err(t.run("claude")))?.code).toBe("AGENT_IMAGE_UNSUPPORTED");

    const t2 = await setup();
    t2.responses.push((cmd) => (cmd[2]?.includes("tar -x") ? { exitCode: 2, stdout: "", stderr: "No space left" } : undefined));
    const e = await err(t2.run("claude"));
    expect(e?.code).toBe("AGENT_SYNC_FAILED");
    expect(e?.message).toContain("No space left");

    const t3 = await setup({}, { tar: 1, npm: 1 });
    t3.host.home = join(t3.home, "empty");
    expect((await err(t3.run("claude")))?.code).toBe("AGENT_NO_CREDENTIALS");
    expect(t3.execs.some((x) => x.cmd[2]?.includes("npm i -g"))).toBe(false);
  });

  test("token in agent env: no Keychain read, no credentials synced", async () => {
    const t = await setup({ agents: { claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: { fromHost: "GH" } } } } });
    let keychainReads = 0;
    t.host.platform = "darwin";
    t.host.readKeychain = async () => { keychainReads++; return null; };
    t.host.home = join(t.home, "no-login"); // would be AGENT_NO_CREDENTIALS if credentials were required
    expect(await t.run("claude")).toBe(0);
    expect(keychainReads).toBe(0);
    expect(last(t)!.args[2]).toMatchObject({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
  });

  test("absent / stopped instance", async () => {
    const t = await setup();
    expect((await err(agent(t.ctx, "zz", "claude", [], { host: t.host })))?.code).toBe("NOT_FOUND");
  });
});
