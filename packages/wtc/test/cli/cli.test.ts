import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const main = join(import.meta.dir, "../../src/cli/main.ts");
const fixture = join(import.meta.dir, "../fixtures/basic");
async function wtc(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", main, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, WTC_FAKE_RUNTIME: "1", ...env } });
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
