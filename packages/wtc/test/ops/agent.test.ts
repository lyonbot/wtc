import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../../src/instance/instance";
import { agent, agentArgv, agentEnv } from "../../src/ops/agent";
import { defineClaudeAgent } from "../../src/agent/claude";
import { defineCodexAgent } from "../../src/agent/codex";
import { type AgentContext, defineAgent } from "../../src/agent/define";
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
      const cmds = /for c in (.+?);/.exec(script)![1]!.split(" ");
      const lines = ["/root", ...cmds.map((c) => `${c}=${probe[c] ?? 0}`)];
      return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const logs: string[] = [];
  const run = (kind: string, args: string[] = []) => agent(t.ctx, "a", kind, args, { host, log: (l) => logs.push(l) });
  return { ...t, host, execs, responses, logs, run };
}
const last = (t: Awaited<ReturnType<typeof setup>>) => t.rt.calls.filter((c) => c.op === "execInteractive").pop();

describe("agentEnv / agentArgv", () => {
  test("built-ins, literal override, fromHost, null drops", () => {
    const d = manifest({ agents: { claude: defineClaudeAgent({ env: { A: "1", T: { fromHost: "GH" }, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null } }) } }).agents.claude!;
    expect(agentEnv("claude", d.env!, { GH: "tok" })).toEqual({ IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", A: "1", T: "tok" });
    const e = (() => { try { agentEnv("claude", d.env!, {}); } catch (x) { return x as { code: string }; } })();
    expect(e?.code).toBe("AGENT_ENV_MISSING");
    expect(agentEnv("codex", manifest().agents.codex!.env!, {})).toEqual({});
  });
  test("argv order: built-in, manifest, CLI; codex adds --no-daemon without ps", () => {
    const m = manifest({ agents: { codex: defineCodexAgent({ args: ["-m", "x"] }) } });
    const c = (ps: boolean) => ({ has: (x: string) => ps || x !== "ps" }) as AgentContext;
    expect(agentArgv(m.agents.codex!, c(true), ["exec", "hi"])).toEqual([
      "bash", "-lc", 'exec codex "$@"', "codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "x", "exec", "hi",
    ]);
    expect(agentArgv(m.agents.codex!, c(false), []).slice(4)).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--no-daemon", "-m", "x"]);
    expect(agentArgv(m.agents.claude!, c(true), ["-p", "x"])).toEqual(["bash", "-lc", 'exec claude "$@"', "claude", "--dangerously-skip-permissions", "-p", "x"]);
  });
});

describe("agent", () => {
  test("installed: probe, sync tar via stdin, launch in cwd with env; exit code passes through", async () => {
    const t = await setup({ cwd: "/workspace/app", agents: { claude: defineClaudeAgent({ env: { T: { fromHost: "GH" } } }) } });
    t.responses.push((cmd) => (cmd[2]?.startsWith("exec claude") ? { exitCode: 7, stdout: "", stderr: "" } : undefined));
    expect(await t.run("claude", ["-p", "hi"])).toBe(7);
    const sync = t.execs.find((e) => e.o?.input)!;
    expect(sync.cmd[2]).toContain('tar -x -C "$HOME"');
    expect(sync.o!.input!.length).toBeGreaterThan(0);
    const merge = t.execs.find((e) => e.cmd[2]?.includes("node -e"))!;
    expect(merge.cmd.at(-1)).toBe(".claude.json");
    expect(t.execs.findIndex((e) => e.cmd[2]?.includes("rm -rf"))).toBeGreaterThan(t.execs.indexOf(merge));
    expect(t.execs.some((e) => e.cmd[2]?.includes("npm i -g"))).toBe(false);
    const c = last(t)!;
    expect(c.args[0]).toBe("wtc-demo--a");
    expect((c.args[1] as string[]).slice(-3)).toEqual(["--dangerously-skip-permissions", "-p", "hi"]);
    expect(c.args[2]).toMatchObject({ workdir: "/workspace/app", env: { IS_SANDBOX: "1", T: "tok" } });
  });

  test("codex sync has no .claude.json merge; --no-daemon only when ps is missing", async () => {
    const t = await setup();
    await t.run("codex", ["exec", "x"]);
    expect(t.execs.some((e) => e.cmd[2]?.includes("node -e"))).toBe(false);
    expect(last(t)!.args[1] as string[]).not.toContain("--no-daemon");
    const t2 = await setup({}, { codex: 1, tar: 1 });
    await t2.run("codex", ["exec", "x"]);
    expect((last(t2)!.args[1] as string[]).slice(4)).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--no-daemon", "exec", "x"]);
  });

  test("missing bin: npm install with version under flock, logs progress", async () => {
    const t = await setup({ agents: { codex: defineCodexAgent({ version: "0.1.2" }) } }, { tar: 1, npm: 1 });
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
    const t = await setup({ agents: { claude: defineClaudeAgent({ env: { CLAUDE_CODE_OAUTH_TOKEN: { fromHost: "GH" } } }) } });
    let keychainReads = 0;
    t.host.platform = "darwin";
    t.host.readKeychain = async () => { keychainReads++; return null; };
    t.host.home = join(t.home, "no-login"); // would be AGENT_NO_CREDENTIALS if credentials were required
    expect(await t.run("claude")).toBe(0);
    expect(keychainReads).toBe(0);
    expect(last(t)!.args[2]).toMatchObject({ env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
  });

  test("unknown agent -> AGENT_UNKNOWN listing the defined ones", async () => {
    const t = await setup();
    const e = await err(t.run("gemini"));
    expect(e?.code).toBe("AGENT_UNKNOWN");
    expect(e?.message).toContain("claude, codex");
  });

  test("custom defineAgent: sync files + env, exec, afterSync after extraction, own args; no pkg -> no install", async () => {
    const order: string[] = [];
    const gemini = defineAgent({
      bin: "gemini",
      env: { K: { fromHost: "GH" } },
      args: ["--yolo"],
      probe: ["jq"],
      async sync(c) {
        order.push("sync");
        c.write(".gemini/settings.json", "{}", "600");
        c.copyFile("~/.gemini/oauth.json", ".gemini/oauth.json");
        c.env.EXTRA = c.has("jq") ? "jq" : "nojq";
        await c.exec("echo hi");
      },
      async afterSync(c) {
        order.push(`after:${t.execs.some((e) => e.o?.input) ? "extracted" : "not-extracted"}`);
        await c.exec(["true"]);
      },
    });
    const t = await setup({ agents: { gemini } }, { gemini: 1, tar: 1, jq: 1 });
    mkdirSync(join(t.host.home, ".gemini"), { recursive: true });
    writeFileSync(join(t.host.home, ".gemini", "oauth.json"), "tok");
    expect(await t.run("gemini", ["-p", "x"])).toBe(0);
    expect(order).toEqual(["sync", "after:extracted"]);
    expect(t.execs[0]!.cmd[2]).toContain("for c in gemini npm tar node ps jq;");
    expect(t.execs.some((e) => e.cmd[2] === "echo hi")).toBe(true);
    const tar = new Bun.Archive(t.execs.find((e) => e.o?.input)!.o!.input!);
    const names = [...(await tar.files()).keys()];
    expect(names).toEqual(expect.arrayContaining([".gemini/settings.json", ".gemini/oauth.json"]));
    const c = last(t)!;
    expect((c.args[1] as string[]).slice(2)).toEqual(['exec gemini "$@"', "gemini", "--yolo", "-p", "x"]);
    expect(c.args[2]).toMatchObject({ env: { K: "tok", EXTRA: "jq" } });

    const t2 = await setup({ agents: { gemini } }, { tar: 1, npm: 1 });
    const e = await err(t2.run("gemini"));
    expect(e?.code).toBe("AGENT_INSTALL_FAILED");
    expect(e?.hint).toContain("pkg");
  });

  test("defineClaudeAgent variant: own configDir mirrored + CLAUDE_CONFIG_DIR, extra env / args / sync", async () => {
    const t = await setup({
      agents: {
        "claude-custom": defineClaudeAgent({
          configDir: "~/.claude-custom",
          env: { ANTHROPIC_BASE_URL: "https://x", DISABLE_AUTOUPDATER: null },
          args: ["--model", "m"],
          sync: (c) => c.write(".custom-marker", "1"),
        }),
      },
    });
    mkdirSync(join(t.host.home, ".claude-custom"), { recursive: true });
    writeFileSync(join(t.host.home, ".claude-custom", ".credentials.json"), JSON.stringify({ claudeAiOauth: { v: "custom" } }));
    writeFileSync(join(t.host.home, ".claude-custom", "CLAUDE.md"), "custom");
    expect(await t.run("claude-custom", ["-p", "x"])).toBe(0);
    const files = await new Bun.Archive(t.execs.find((e) => e.o?.input)!.o!.input!).files();
    expect(await files.get(".claude-custom/.credentials.json")!.text()).toContain("custom");
    expect(files.has(".claude-custom/CLAUDE.md")).toBe(true);
    expect(files.has(".claude/.credentials.json")).toBe(false);
    expect(files.has(".custom-marker")).toBe(true);
    expect(t.execs.find((e) => e.cmd[2]?.includes("node -e"))!.cmd.at(-1)).toBe(".claude-custom/.claude.json");
    const c = last(t)!;
    expect((c.args[1] as string[]).slice(4)).toEqual(["--dangerously-skip-permissions", "--model", "m", "-p", "x"]);
    expect(c.args[2]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: "/root/.claude-custom", ANTHROPIC_BASE_URL: "https://x", IS_SANDBOX: "1" } });
    expect((c.args[2] as { env: Record<string, string> }).env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  test("defineCodexAgent variant: configDir outside the host home lands under .wtc-agents/<name> + CODEX_HOME", async () => {
    const t = await setup();
    const dir = join(t.home, "elsewhere-codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), '{"v":"other"}');
    t.ctx.setup.manifest.agents["codex-alt"] = defineCodexAgent({ configDir: dir });
    await t.run("codex-alt");
    const files = await new Bun.Archive(t.execs.find((e) => e.o?.input)!.o!.input!).files();
    expect(await files.get(".wtc-agents/codex-alt/auth.json")!.text()).toBe('{"v":"other"}');
    expect(last(t)!.args[2]).toMatchObject({ env: { CODEX_HOME: "/root/.wtc-agents/codex-alt" } });
  });

  test("absent / stopped instance", async () => {
    const t = await setup();
    expect((await err(agent(t.ctx, "zz", "claude", [], { host: t.host })))?.code).toBe("NOT_FOUND");
  });
});
