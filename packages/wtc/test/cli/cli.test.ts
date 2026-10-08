import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const main = join(import.meta.dir, "../../src/cli/main.ts");
const fixture = join(import.meta.dir, "../fixtures/basic");
async function wtc(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const p = Bun.spawn(["bun", main, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: { ...process.env, WTC_FAKE_RUNTIME: "1", ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("cli", () => {
  test("usage error inside action: exit 2 with stderr message", async () => {
    const r = await wtc(["up", "x", "--set", "foo"], { WTC_SETUP: fixture });
    expect(r.code).toBe(2);
    expect(r.err).toContain("error: --set expects K=V");
    const o = await wtc(["open", "x", "vim"], { WTC_SETUP: fixture });
    expect(o.code).toBe(2);
    expect(o.err).toContain("error:");
  });

  test("--help lists all commands", async () => {
    const r = await wtc(["--help"]);
    for (const c of ["build", "up", "start", "stop", "restart", "rm", "ls", "status", "logs", "run", "check", "shell", "agent", "tunnel", "open", "gc", "skill", "doctor", "init"])
      expect(r.out).toContain(c);
  });

  test("bare wtc without a terminal prints help instead of opening the TUI", async () => {
    const r = await wtc([], { WTC_SETUP: fixture });
    expect(r.out + r.err).toContain("Usage: wtc");
    const s = await wtc(["--setup", fixture], {});
    expect(s.out + s.err).toContain("Usage: wtc");
    const n = await wtc([], { WTC_SETUP: "" }, "/"); // no setup: the `wtc init` hint is for terminals only
    expect(n.out + n.err).toContain("Usage: wtc");
    expect(n.err).not.toContain("no wtc.setup.ts found");
  });

  test("run without a script lists container and host scripts", async () => {
    const ex = join(import.meta.dir, "../../../../examples/setup-basic");
    const r = await wtc(["run"], { WTC_SETUP: ex });
    expect(r.code).toBe(0);
    expect(r.out).toContain("restart-dev-server");
    expect(r.out).toContain("wtc run --host");
    expect(r.out).toContain("show-url");
    const j = JSON.parse((await wtc(["run", "x", "--json"], { WTC_SETUP: ex })).out);
    expect(j.scripts.map((s: { name: string }) => s.name)).toContain("restart-dev-server");
    expect(j.hostScripts).toContainEqual({ name: "show-url", description: "print how to reach the dev server" });
  });

  test("run on the wrong side hints at --host", async () => {
    const ex = join(import.meta.dir, "../../../../examples/setup-basic");
    const r = await wtc(["run", "x", "show-url"], { WTC_SETUP: ex });
    expect(r.code).toBe(1);
    expect(r.err).toContain("wtc run --host x show-url");
    const h = await wtc(["run", "--host", "x", "restart-dev-server"], { WTC_SETUP: ex });
    expect(h.code).toBe(1);
    expect(h.err).toContain('no host script "restart-dev-server"');
    expect(h.err).toContain("wtc run x restart-dev-server");
    const n = await wtc(["run", "x", "nope"], { WTC_SETUP: ex });
    expect(n.err).toContain("hint: `wtc run` lists all scripts");
  });

  test("ls --json with fake runtime prints []", async () => {
    const r = await wtc(["ls", "--json"], { WTC_SETUP: fixture });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("--setup flag and ls table", async () => {
    const r = await wtc(["--setup", fixture, "ls"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no instances");
  });

  test("gc --prune-store reports the store outcome instead of `nothing to clean`", async () => {
    const r = await wtc(["gc", "--dry-run", "--prune-store"], { WTC_SETUP: fixture });
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped pnpm store prune: current image not built");
    expect(r.out).not.toContain("nothing to clean");
  });

  test("WtcError -> stderr, exit 1", async () => {
    const r = await wtc(["tunnel", "nope"], { WTC_SETUP: fixture });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error: /);
  });

  test("missing setup -> error with hint", async () => {
    const r = await wtc(["ls"], { WTC_SETUP: "/nonexistent-wtc-dir" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("error:");
  });

  test("usage error exits 2", async () => {
    const r = await wtc(["bogus"]);
    expect(r.code).toBe(2);
  });

  test("init needs no setup; --json reports created files; second run is SETUP_EXISTS", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wtc-cli-init-")), "demo");
    try {
      const r = await wtc(["init", dir, "--json"], { WTC_SETUP: "" });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ dir, id: "demo" });
      const again = await wtc(["init", dir]);
      expect(again.code).toBe(1);
      expect(again.err).toContain("already exists");
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  test("skill prints SKILL.md; --llms strips frontmatter", async () => {
    const a = await wtc(["skill"]);
    expect(a.out.startsWith("---\nname: wtc")).toBe(true);
    const b = await wtc(["skill", "--llms"]);
    expect(b.out.startsWith("# wtc")).toBe(true);
  });
});
