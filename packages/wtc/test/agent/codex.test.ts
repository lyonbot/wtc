import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBundle, filterCodexConfig, toToml } from "../../src/agent/codex";

const root = mkdtempSync(join(tmpdir(), "wtc-codex-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};

const HOST_TOML = `
model = "gpt-x"
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"
approvals_reviewer = "auto_review"
notify = ["/Users/u/bin/notify"]

[projects."/Users/u/src/app"]
trust_level = "trusted"

[features]
web_search = true

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
http_headers = { CONTEXT7_API_KEY = "k" }

[mcp_servers.node_repl]
command = "node"
args = ["/Users/u/.codex/plugins/repl.js"]

[mcp_servers.local.env]
HOME_DIR = "/Users/u"

[mcp_servers.app_bundled]
command = "/Applications/ChatGPT.app/Contents/Resources/node_repl"

[mcp_servers.relative_app]
command = "./Codex Computer Use.app/Contents/MacOS/Client"
cwd = "."

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

[plugins."x@y"]
enabled = true

[hooks.state]
a = 1
`;

describe("filterCodexConfig", () => {
  test("keeps whitelisted keys, drops host-path MCP servers, output reparses", () => {
    const out = filterCodexConfig(HOST_TOML, "/Users/u", "/workspace/app");
    const cfg = Bun.TOML.parse(out) as any;
    expect(cfg).toEqual({
      model: "gpt-x",
      model_reasoning_effort: "medium",
      features: { web_search: true },
      mcp_servers: {
        context7: { url: "https://mcp.context7.com/mcp", http_headers: { CONTEXT7_API_KEY: "k" } },
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
      check_for_update_on_startup: false,
      analytics: { enabled: false },
      projects: { "/workspace/app": { trust_level: "trusted" } },
    });
    expect((Bun.TOML.parse(filterCodexConfig("", "/Users/u", "/w")) as any).projects).toEqual({ "/w": { trust_level: "trusted" } });
  });
  test("drops Linux host-only paths (home, /snap, /nix) too", () => {
    const toml = `[mcp_servers.a]\ncommand = "/home/u/bin/a"\n[mcp_servers.b]\ncommand = "/snap/bin/b"\n[mcp_servers.c]\ncommand = "/nix/store/x/bin/c"\n[mcp_servers.d]\ncommand = "uvx"\n`;
    expect(Object.keys((Bun.TOML.parse(filterCodexConfig(toml, "/home/u", "/w")) as any).mcp_servers)).toEqual(["d"]);
  });
  test("toToml quotes odd keys and round-trips arrays of tables", () => {
    const v = { a: { "x.y": { k: "v" } }, arr: [{ n: 1 }, { n: 2 }], s: 'q"uote' };
    expect(Bun.TOML.parse(toToml(v))).toEqual(v);
  });
});

describe("codexBundle", () => {
  test("auth + MCP OAuth file 600, filtered config, AGENTS.md, skills minus .system, ~/.agents/skills; CODEX_HOME honored", () => {
    const home = mkdtempSync(join(root, "h-"));
    const dir = join(home, "codex-home");
    put(join(dir, "auth.json"), "{}");
    put(join(dir, ".credentials.json"), "{}");
    put(join(dir, "config.toml"), HOST_TOML.replaceAll("/Users/u", home));
    put(join(dir, "AGENTS.md"), "a");
    put(join(dir, "skills/mine/SKILL.md"), "m");
    put(join(dir, "skills/.system/x/SKILL.md"), "sys");
    put(join(dir, "hooks.json"), "{}");
    put(join(home, ".agents/skills/shared/SKILL.md"), "s");
    const b = codexBundle({ home, env: { CODEX_HOME: dir }, platform: "linux", readKeychain: async () => null }, "/w");
    expect([...b.files.keys()].sort()).toEqual([
      ".agents/skills/shared/SKILL.md", ".codex/.credentials.json", ".codex/AGENTS.md", ".codex/auth.json", ".codex/config.toml", ".codex/skills/mine/SKILL.md",
    ]);
    expect(b.modes.get(".codex/auth.json")).toBe("600");
    expect(b.modes.get(".codex/.credentials.json")).toBe("600");
    const cfg = Bun.TOML.parse(new TextDecoder().decode(b.files.get(".codex/config.toml"))) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual(["context7", "playwright"]);
  });
  test("no auth.json -> AGENT_NO_CREDENTIALS", () => {
    const home = mkdtempSync(join(root, "h-"));
    let e: any;
    try { codexBundle({ home, env: {}, platform: "linux", readKeychain: async () => null }, "/w"); } catch (x) { e = x; }
    expect(e?.code).toBe("AGENT_NO_CREDENTIALS");
  });
});
