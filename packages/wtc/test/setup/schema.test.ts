import { describe, expect, test } from "bun:test";
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
      agents: {
        claude: { env: {}, args: [], version: "latest" },
        codex: { env: {}, args: [], version: "latest" },
      },
    });
  });
  test("agents: env literal / fromHost / null, args, version; strict", () => {
    const m = ok({ agents: { claude: { env: { A: "1", B: { fromHost: "X" }, C: null }, args: ["--model", "opus"], version: "2.1.0" } } });
    expect(m.agents.claude).toEqual({ env: { A: "1", B: { fromHost: "X" }, C: null }, args: ["--model", "opus"], version: "2.1.0" });
    expect(m.agents.codex).toEqual({ env: {}, args: [], version: "latest" });
    bad({ agents: { gemini: {} } });
    bad({ agents: { claude: { env: { lower: "x" } } } });
    bad({ agents: { claude: { env: { A: { fromHost: "" } } } } });
    bad({ agents: { claude: { extra: 1 } } });
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
