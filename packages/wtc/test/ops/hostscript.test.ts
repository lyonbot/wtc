import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instancePaths } from "../../src/instance/create-spec";
import { containerName } from "../../src/naming";
import { runHost } from "../../src/ops/hostscript";
import { stats } from "../../src/ops/stats";
import { suggest } from "../../src/ops/suggest";
import { mkCtx } from "../instance/helpers";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const mk = (m: Parameters<typeof mkCtx>[0] = {}) => {
  const r = mkCtx(m);
  cleanups.push(r.cleanup);
  return r;
};
async function addInstance(r: ReturnType<typeof mk>, name: string, state: "running" | "exited" = "running") {
  const c = containerName("demo", name);
  await r.rt.create({ name: c, image: "i", labels: { "wtc.setup": "demo", "wtc.name": name }, env: {}, mounts: [], ports: [], entrypoint: [], extraHosts: [] });
  if (state === "running") await r.rt.start(c);
}

describe("runHost", () => {
  test("runs on the host in the setup dir with name as $1 and params in env", async () => {
    const r = mk({ hostScripts: { chrome: { run: "./chrome.sh --x", description: "d" } } });
    await addInstance(r, "a");
    const p = instancePaths(r.dir, "a");
    mkdirSync(p.run, { recursive: true });
    writeFileSync(p.config, JSON.stringify({ params: { BRANCH: "feat/x" }, container: {} }));
    let seen: { argv: string[]; cwd: string; env: Record<string, string> } | undefined;
    const code = await runHost(r.ctx, "a", "chrome", ["u"], async (argv, o) => ((seen = { argv, ...o }), 7));
    expect(code).toBe(7);
    expect(seen!.argv).toEqual(["bash", "-c", './chrome.sh --x "$@"', "chrome", "a", "u"]);
    expect(seen!.cwd).toBe(r.dir);
    expect(seen!.env).toMatchObject({ WTC_NAME: "a", WTC_SETUP_ID: "demo", WTC_SETUP_DIR: r.dir, BRANCH: "feat/x" });
  });
  test("unknown script lists available; missing instance is NOT_FOUND", async () => {
    const r = mk({ hostScripts: { chrome: { run: "x", description: "d" } } });
    await expect(runHost(r.ctx, "a", "nope", [], async () => 0)).rejects.toMatchObject({ code: "SCRIPT_NOT_FOUND", message: expect.stringContaining("chrome") });
    await expect(runHost(r.ctx, "ghost", "chrome", [], async () => 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("really spawns (default spawn): exit code and cwd", async () => {
    const r = mk({ hostScripts: { t: { run: 'f() { [ . -ef "$WTC_SETUP_DIR" ] && return 3; return 1; }; f', description: "d" } } });
    await addInstance(r, "a");
    expect(await runHost(r.ctx, "a", "t", [])).toBe(3);
  });
});

describe("suggest", () => {
  test("filters nothing, dedupes, passes context; failing/slow suggest -> []", async () => {
    const r = mk({
      params: {
        B: { description: "b", suggest: (input: string, c: { setupDir: string; params: Record<string, string> }) => ["x", "x", "y", "", input, c.params.OTHER ?? "-"] },
        BAD: { description: "b", suggest: () => { throw new Error("offline"); } },
        PLAIN: { description: "p" },
      },
    });
    expect(await suggest(r.ctx.setup, "B", "in", { OTHER: "o" })).toEqual(["x", "y", "in", "o"]);
    expect(await suggest(r.ctx.setup, "BAD", "")).toEqual([]);
    expect(await suggest(r.ctx.setup, "PLAIN", "")).toEqual([]);
    await expect(suggest(r.ctx.setup, "NOPE", "")).rejects.toMatchObject({ code: "PARAM_UNKNOWN" });
  });
});

describe("suggest size", () => {
  test("keeps long candidate lists whole (the form filters them locally)", async () => {
    const all = Array.from({ length: 4000 }, (_, i) => `branch-${i}`);
    const r = mk({ params: { B: { description: "b", suggest: () => all } } });
    expect(await suggest(r.ctx.setup, "B", "")).toHaveLength(4000);
  });
});

describe("stats", () => {
  test("keyed by instance name, running only; runtime failure -> {}", async () => {
    const r = mk();
    await addInstance(r, "a");
    await addInstance(r, "b", "exited");
    r.rt.statsByName[containerName("demo", "a")] = { cpuPercent: 5, memBytes: 10, memLimitBytes: 100 };
    expect(await stats(r.ctx, ["a", "b", "ghost"])).toEqual({ a: { cpuPercent: 5, memBytes: 10, memLimitBytes: 100 } });
    r.rt.stats = async () => { throw new Error("daemon down"); };
    expect(await stats(r.ctx, ["a"])).toEqual({});
  });
});
