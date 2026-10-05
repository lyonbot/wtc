import { describe, expect, test } from "bun:test";
import { defineClaudeAgent } from "../../src/agent/claude";
import { defineAgent } from "../../src/agent/define";
import { manifestSchema } from "../../src/setup/schema";

const ok = (o: object) => manifestSchema.parse({ id: "basic", ...o });
const bad = (o: object) => expect(() => ok(o)).toThrow();

describe("manifest schema", () => {
  test("defaults on minimal input", () => {
    const m = ok({});
    expect(m).toEqual({
      id: "basic",
      image: { context: "image", dockerfile: "Dockerfile", buildArgs: {} },
      init: "init.sh",
      params: {},
      cwd: "/workspace",
      scripts: {},
      checks: {},
      hostForwards: [],
      socksPort: 1080,
      socksBind: "0.0.0.0",
      socksHostPortRange: [21080, 21179],
      mounts: [],
      readyTimeout: 900,
      ssh: { knownHosts: [] },
      agents: { claude: expect.objectContaining({ bin: "claude" }), codex: expect.objectContaining({ bin: "codex" }) },
    });
  });
  test("agents: built-in overrides (env literal / fromHost / null, args, version); plain objects rejected", () => {
    const m = ok({ agents: { claude: defineClaudeAgent({ env: { A: "1", B: { fromHost: "X" }, IS_SANDBOX: null }, args: ["--model", "opus"], version: "2.1.0" }) } });
    expect(m.agents.claude).toMatchObject({
      bin: "claude", pkg: "@anthropic-ai/claude-code", version: "2.1.0",
      env: { A: "1", B: { fromHost: "X" }, DISABLE_AUTOUPDATER: "1" },
      args: ["--dangerously-skip-permissions", "--model", "opus"],
    });
    expect(m.agents.claude!.env).not.toHaveProperty("IS_SANDBOX");
    expect(m.agents.codex).toMatchObject({ bin: "codex", pkg: "@openai/codex", version: "latest" });
    expect(() => ok({ agents: { claude: { env: {} } } })).toThrow("defineClaudeAgent");
    bad({ agents: { gemini: {} } });
    bad({ agents: { gemini: { bin: "gemini" } } });
    bad({ agents: { claude: defineClaudeAgent({ env: { lower: "x" } }) } });
    bad({ agents: { claude: defineClaudeAgent({ env: { A: { fromHost: "" } } }) } });
  });
  test("agents: definitions validated, defaults applied, functions kept", () => {
    const sync = () => {};
    const m = ok({ agents: { gemini: defineAgent({ bin: "gemini", pkg: "@google/gemini-cli", sync }), cc: defineClaudeAgent({ bin: "claude-x" }) } });
    expect(m.agents.gemini).toEqual({ bin: "gemini", pkg: "@google/gemini-cli", version: "latest", env: {}, args: [], probe: [], sync });
    expect(m.agents.cc).toMatchObject({ bin: "claude-x", pkg: undefined });
    bad({ agents: { gemini: defineAgent({ bin: "a b" }) } });
    bad({ agents: { gemini: defineAgent({ bin: "g", extra: 1 } as never) } });
    bad({ agents: { gemini: defineAgent({ bin: "g", sync: "nope" } as never) } });
    bad({ agents: { Bad: defineAgent({ bin: "g" }) } });
  });
  test("check timeout default", () => {
    expect(ok({ checks: { web: { run: "true" } } }).checks.web!.timeout).toBe(10);
  });
  test("id and volume name must match ID_RE", () => {
    bad({ id: "Bad_ID" });
    bad({ id: "a--b" });
    bad({ mounts: [{ type: "volume", name: "M2", target: "/x", scope: "setup" }] });
    ok({ mounts: [{ type: "volume", name: "m2", target: "/x", scope: "setup" }] });
  });
  test("mount targets must not collide with /wtc or /pnpm", () => {
    for (const target of ["/wtc", "/wtc/bin", "/pnpm", "/pnpm/store"])
      bad({ mounts: [{ type: "bind", source: "/x", target }] });
    ok({ mounts: [{ type: "bind", source: "/x", target: "/wtcx" }] });
  });
  test("bind source expands ~", () => {
    const m = ok({ mounts: [{ type: "bind", source: "~/d", target: "/d" }] });
    expect((m.mounts[0] as any).source).toBe(`${require("os").homedir()}/d`);
  });
  test("ports", () => {
    bad({ socksPort: 0 });
    bad({ socksPort: 65536 });
    bad({ hostForwards: [70000] });
    bad({ hostForwards: [1080] });
    ok({ socksPort: 1081, hostForwards: [1080] });
    bad({ socksHostPortRange: [300, 200] });
    bad({ socksHostPortRange: [0, 200] });
  });
  test("param keys and pattern", () => {
    ok({ params: { FOO_1: { description: "d", pattern: "^a+$" } } });
    bad({ params: { foo: { description: "d" } } });
    bad({ params: { FOO: { description: "d", pattern: "(" } } });
  });
});
