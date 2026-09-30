import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDir, addMcpRemoteAuth, Bundle, mapStrings, prefixRewriter } from "../../src/agent/bundle";

const root = mkdtempSync(join(tmpdir(), "wtc-bundle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const txt = (b: Bundle, p: string) => new TextDecoder().decode(b.files.get(p));

describe("addDir", () => {
  test("follows symlinks (relative, outside, dir), skips broken links, cycles and .git/node_modules/.DS_Store", () => {
    const src = join(root, "skills");
    const outside = join(root, "outside", "s2");
    mkdirSync(join(src, "s1", "scripts"), { recursive: true });
    mkdirSync(join(src, "s1", ".git"), { recursive: true });
    mkdirSync(join(src, "s1", "node_modules", "x"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(src, "s1", "SKILL.md"), "one");
    writeFileSync(join(src, "s1", "scripts", "run.sh"), "#!/bin/sh");
    chmodSync(join(src, "s1", "scripts", "run.sh"), 0o755);
    writeFileSync(join(src, "s1", ".git", "HEAD"), "ref");
    writeFileSync(join(src, "s1", "node_modules", "x", "i.js"), "");
    writeFileSync(join(src, ".DS_Store"), "");
    writeFileSync(join(outside, "SKILL.md"), "two");
    symlinkSync(outside, join(src, "s2"));
    symlinkSync("s1/SKILL.md", join(src, "rel.md"));
    symlinkSync(join(root, "missing"), join(src, "broken"));
    symlinkSync(src, join(src, "s1", "loop"));

    const b = new Bundle();
    addDir(b, src, ".claude/skills", (rel) => rel === "skip-me");
    expect([...b.files.keys()].sort()).toEqual([
      ".claude/skills/rel.md",
      ".claude/skills/s1/SKILL.md",
      ".claude/skills/s1/scripts/run.sh",
      ".claude/skills/s2/SKILL.md",
    ]);
    expect(txt(b, ".claude/skills/s2/SKILL.md")).toBe("two");
    expect(txt(b, ".claude/skills/rel.md")).toBe("one");
    expect(b.modes.get(".claude/skills/s1/scripts/run.sh")).toBe("755");
    expect(b.modes.has(".claude/skills/s1/SKILL.md")).toBe(false);
  });
  test("missing source is a no-op", () => {
    const b = new Bundle();
    addDir(b, join(root, "nope"), "x");
    expect(b.files.size).toBe(0);
  });
});

describe("tar", () => {
  test("contains files plus the modes list", async () => {
    const b = new Bundle();
    b.add(".codex/auth.json", "{}", "600");
    b.add("a/b", "x");
    const out = join(root, "t.tar");
    await Bun.write(out, await b.tar());
    const list = Bun.spawnSync(["tar", "-tf", out]).stdout.toString().trim().split("\n").sort();
    expect(list).toEqual([".codex/auth.json", ".wtc-agent/modes", "a/b"]);
    const modes = Bun.spawnSync(["tar", "-xOf", out, ".wtc-agent/modes"]).stdout.toString();
    expect(modes).toBe("600 .codex/auth.json\n");
  });
});

describe("rewrite helpers", () => {
  test("prefixRewriter matches whole path segments only", () => {
    const f = prefixRewriter([["/Users/u/.claude", "/root/.claude"]]);
    expect(f("/Users/u/.claude")).toBe("/root/.claude");
    expect(f("/Users/u/.claude/plugins/x")).toBe("/root/.claude/plugins/x");
    expect(f("/Users/u/.claude-work/x")).toBe("/Users/u/.claude-work/x");
    expect(mapStrings({ a: ["/Users/u/.claude/p", 1], b: { c: "x" } }, f)).toEqual({ a: ["/root/.claude/p", 1], b: { c: "x" } });
  });
});

describe("addMcpRemoteAuth", () => {
  test("copies ~/.mcp-auth (or MCP_REMOTE_CONFIG_DIR) with every file 600", () => {
    const home = join(root, "mr-home");
    mkdirSync(join(home, ".mcp-auth", "mcp-remote-v1"), { recursive: true });
    writeFileSync(join(home, ".mcp-auth", "mcp-remote-v1", "abc_tokens.json"), "{}");
    const b = new Bundle();
    b.add("other", "x");
    addMcpRemoteAuth(b, home, {});
    expect(b.modes.get(".mcp-auth/mcp-remote-v1/abc_tokens.json")).toBe("600");
    expect(b.modes.has("other")).toBe(false);
    const alt = join(root, "mr-alt");
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, "t.json"), "{}");
    const b2 = new Bundle();
    addMcpRemoteAuth(b2, home, { MCP_REMOTE_CONFIG_DIR: alt });
    expect([...b2.files.keys()]).toEqual([".mcp-auth/t.json"]);
  });
});
