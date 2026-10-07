import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/main";

const skill = readFileSync(join(import.meta.dir, "../../skill/SKILL.md"), "utf8");

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("SKILL.md", () => {
  test("has frontmatter", () => {
    expect(skill).toMatch(/^---\nname: wtc\ndescription: .{40,}\n---\n/);
  });
  test("mentions every command", () => {
    for (const c of buildProgram().commands) expect(skill).toContain(`wtc ${c.name()}`);
  });
  test("mentions every WtcError code thrown in lib", () => {
    const codes = new Set<string>();
    for (const f of walk(join(import.meta.dir, "../../src")))
      for (const m of readFileSync(f, "utf8").matchAll(/new WtcError\(\s*"([A-Z_]+)"/g)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThan(5);
    for (const c of codes) expect(skill).toContain(`\`${c}\``);
  });
});
