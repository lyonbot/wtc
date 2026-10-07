import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_JSON_PATCH, claudeBundle, mergeClaudeJsonScript, readClaudeCredentials } from "../../src/agent/claude";
import type { HostEnv } from "../../src/agent/host";
import type { Bundle } from "../../src/agent/bundle";

const root = mkdtempSync(join(tmpdir(), "wtc-claude-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "a" }, mcpOAuth: {} });
const put = (p: string, s: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
const json = (b: Bundle, p: string) => JSON.parse(new TextDecoder().decode(b.files.get(p)));

function mkHost(o: Partial<HostEnv> = {}, keychain: string | null = null): HostEnv {
  const home = mkdtempSync(join(root, "h-"));
  return { home, env: {}, platform: "linux", readKeychain: async () => keychain, ...o };
}

describe("readClaudeCredentials", () => {
  test("darwin prefers a valid Keychain entry over the file", async () => {
    const h = mkHost({ platform: "darwin" }, CREDS + "\n");
    put(join(h.home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "stale" } }));
    expect(await readClaudeCredentials(h)).toBe(CREDS);
  });
  test("falls back to the file when Keychain is absent or not credentials JSON", async () => {
    const h = mkHost({ platform: "darwin" }, "garbage");
    put(join(h.home, ".claude/.credentials.json"), CREDS);
    expect(JSON.parse(await readClaudeCredentials(h)).claudeAiOauth.accessToken).toBe("a");
  });
  test("honors CLAUDE_CONFIG_DIR; nothing -> AGENT_NO_CREDENTIALS", async () => {
    const h = mkHost();
    const cfg = join(h.home, "alt");
    put(join(cfg, ".credentials.json"), CREDS);
    expect(await readClaudeCredentials({ ...h, env: { CLAUDE_CONFIG_DIR: cfg } })).toContain("claudeAiOauth");
    const e = await readClaudeCredentials(mkHost()).catch((x) => x);
    expect(e.code).toBe("AGENT_NO_CREDENTIALS");
  });  test("custom config dir reads the hashed Keychain item claude uses for it", async () => {
    const services: string[] = [];
    const h = mkHost({ platform: "darwin", readKeychain: async (s) => { services.push(s); return CREDS; } });
    await readClaudeCredentials(h);
    await readClaudeCredentials(h, "/Users/u/.claude-custom");
    const hash = new Bun.CryptoHasher("sha256").update("/Users/u/.claude-custom").digest("hex").slice(0, 8);
    expect(services).toEqual(["Claude Code-credentials", `Claude Code-credentials-${hash}`]);
  });
});

describe("claudeBundle", () => {
  test("credentials 600, settings blocklist, plugins rewrite and directory marketplace, .claude.json patch", async () => {
    const h = mkHost();
    const C = join(h.home, ".claude");
    const devMkt = join(h.home, "dev", "my-plugins");
    put(join(C, ".credentials.json"), CREDS);
    put(join(C, "settings.json"), JSON.stringify({
      model: "opus", attribution: { commit: "" }, hooks: { SessionStart: [] }, statusLine: { command: "x" }, apiKeyHelper: "x",
      extraKnownMarketplaces: { mine: { source: { source: "directory", path: devMkt } } },
    }));
    put(join(C, "CLAUDE.md"), "rules");
    put(join(C, "skills/s/SKILL.md"), "s");
    put(join(C, "history.jsonl"), "no");
    put(join(C, "plugins/cache/o/p/1/plugin.json"), "{}");
    put(join(C, "plugins/marketplaces/o/.git/HEAD"), "ref");
    put(join(C, "plugins/marketplaces/o/m.json"), "{}");
    put(join(C, "plugins/repos/r"), "no");
    put(join(C, "plugins/data/d"), "no");
    put(join(C, "plugins/plugin-catalog-cache.json"), "{}");
    put(join(C, "plugins/installed_plugins.json"), JSON.stringify({ plugins: { "p@o": [{ installPath: `${C}/plugins/cache/o/p/1` }] } }));
    put(join(C, "plugins/known_marketplaces.json"), JSON.stringify({
      o: { source: { source: "github", repo: "o/o" }, installLocation: `${C}/plugins/marketplaces/o` },
      mine: { source: { source: "directory", path: devMkt }, installLocation: devMkt },
    }));
    put(join(devMkt, ".claude-plugin/marketplace.json"), "{}");
    put(join(devMkt, ".git/HEAD"), "ref");
    put(join(h.home, ".claude.json"), JSON.stringify({ mcpServers: { c7: { type: "http" }, mac: { command: "/Applications/X.app/bin/srv" }, mine: { command: `${h.home}/bin/srv` } }, oauthAccount: { a: 1 }, projects: { "/x": {} }, numStartups: 9 }));

    const b = await claudeBundle(h, "/root", "/workspace/app");
    const keys = [...b.files.keys()];
    expect(b.modes.get(".claude/.credentials.json")).toBe("600");
    expect(keys).toContain(".claude/CLAUDE.md");
    expect(keys).toContain(".claude/skills/s/SKILL.md");
    expect(keys).toContain(".claude/plugins/cache/o/p/1/plugin.json");
    expect(keys).toContain(".claude/plugins/marketplaces/o/m.json");
    expect(keys).toContain(".claude/plugins/marketplaces/mine/.claude-plugin/marketplace.json");
    for (const k of keys) {
      expect(k).not.toContain(".git/");
      expect(k).not.toMatch(/history\.jsonl|plugins\/(repos|data)\/|plugin-catalog-cache/);
    }

    const s = json(b, ".claude/settings.json");
    expect(s).toMatchObject({ model: "opus", attribution: { commit: "" }, skipDangerousModePermissionPrompt: true });
    expect(s.hooks).toBeUndefined();
    expect(s.statusLine).toBeUndefined();
    expect(s.apiKeyHelper).toBeUndefined();
    expect(s.extraKnownMarketplaces.mine.source.path).toBe("/root/.claude/plugins/marketplaces/mine");

    expect(json(b, ".claude/plugins/installed_plugins.json").plugins["p@o"][0].installPath).toBe("/root/.claude/plugins/cache/o/p/1");
    const km = json(b, ".claude/plugins/known_marketplaces.json");
    expect(km.o.installLocation).toBe("/root/.claude/plugins/marketplaces/o");
    expect(km.mine).toEqual({ source: { source: "directory", path: "/root/.claude/plugins/marketplaces/mine" }, installLocation: "/root/.claude/plugins/marketplaces/mine" });

    expect(json(b, CLAUDE_JSON_PATCH)).toEqual({
      hasCompletedOnboarding: true,
      hasSeenAutoDefaultNudge: true,
      projects: { "/workspace/app": { hasTrustDialogAccepted: true } },
      mcpServers: { c7: { type: "http" } },
      oauthAccount: { a: 1 },
    });
  });
});

describe("mergeClaudeJsonScript", () => {
  const runMerge = (home: string) => {
    const r = Bun.spawnSync(["bun", "-e", mergeClaudeJsonScript], { env: { ...process.env, HOME: home } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  };
  const patch = { hasCompletedOnboarding: true, mcpServers: { a: {} }, projects: { "/w": { hasTrustDialogAccepted: true } } };
  test("keeps container fields, replaces top-level keys, deep-merges projects", () => {
    const home = mkdtempSync(join(root, "c-"));
    put(join(home, CLAUDE_JSON_PATCH), JSON.stringify(patch));
    put(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { old: {} }, projects: { "/w": { history: [1] }, "/o": { x: 1 } } }));
    expect(runMerge(home)).toEqual({
      numStartups: 3,
      hasCompletedOnboarding: true,
      mcpServers: { a: {} },
      projects: { "/w": { history: [1], hasTrustDialogAccepted: true }, "/o": { x: 1 } },
    });
  });
  test("missing .claude.json starts from {}", () => {
    const home = mkdtempSync(join(root, "c-"));
    put(join(home, CLAUDE_JSON_PATCH), JSON.stringify(patch));
    expect(runMerge(home)).toEqual(patch);
  });
});
