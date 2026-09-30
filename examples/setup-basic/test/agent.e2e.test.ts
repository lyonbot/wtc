/**
 * Real end-to-end test for `wtc agent` against examples/setup-basic. Gated: WTC_AGENT_E2E=1.
 * Uses the host's real Claude Code / Codex logins and spends tokens. Setup copied under $HOME/.cache/wtc-it
 * with id "wtcag"; everything labelled wtc.setup=wtcag is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as lib from "../../../packages/lib/src/index";
import { createWtc, DockerCliRuntime, type Wtc } from "../../../packages/lib/src/index";

const E2E = process.env.WTC_AGENT_E2E === "1";
const ID = "wtcag";
const MIN = 60_000;
Bun.plugin({ name: "wtc-virtual-ag", setup: (b) => void b.module("wtc", () => ({ exports: { ...lib }, loader: "object" })) });

const root = join(homedir(), ".cache", "wtc-it", `agent-${Date.now().toString(36)}`);
const rt = new DockerCliRuntime();
const container = `wtc-${ID}--e2e`;
let w: Wtc;

async function sh(argv: string[]) {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
async function cleanup() {
  const ids = (await sh(["docker", "ps", "-aq", "--filter", `label=wtc.setup=${ID}`])).stdout.split("\n").filter(Boolean);
  if (ids.length) await sh(["docker", "rm", "-f", ...ids]);
  const vols = (await sh(["docker", "volume", "ls", "-q", "--filter", `label=wtc.setup=${ID}`])).stdout.split("\n").filter(Boolean);
  if (vols.length) await sh(["docker", "volume", "rm", "-f", ...vols]);
}
/** Shell in the container (login shell, like the agent sees it). */
const inC = (script: string) => rt.exec(container, ["bash", "-lc", script]);

describe.skipIf(!E2E)("wtc agent (real logins)", () => {
  beforeAll(async () => {
    await cleanup();
    const dir = join(root, "setup");
    mkdirSync(dir, { recursive: true });
    cpSync(join(import.meta.dir, ".."), dir, { recursive: true, filter: (s) => !/\/(\.wtc|test|node_modules)$/.test(s) });
    const f = join(dir, "wtc.setup.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace(`id: "basic",`, `id: "${ID}",\n  socksHostPortRange: [22280, 22379],\n  agents: { claude: { env: { WTC_E2E_MARK: "from-manifest" } } },`));
    w = await createWtc({ setupDir: dir, runtime: rt });
    for await (const e of w.up("e2e", {})) if (e.type === "done") expect(e.summary.state).toBe("ready");
  }, 15 * MIN);

  afterAll(async () => {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  test("claude: auto-installs, runs a real task in cwd, sees manifest env", async () => {
    expect((await inC("command -v claude")).exitCode).not.toBe(0);
    const code = await w.agent("e2e", "claude", ["-p",
      "Using the Bash tool, run exactly: printf '%s' \"CLAUDE_OK:$WTC_E2E_MARK\" > claude.txt  — then reply with the single word done."]);
    expect(code).toBe(0);
    expect((await inC("cat /workspace/app/claude.txt")).stdout).toBe("CLAUDE_OK:from-manifest");
  }, 10 * MIN);

  test("synced state: creds 600, user MCP servers, skills, no .git under plugins, profile env", async () => {
    expect((await inC("stat -c %a ~/.claude/.credentials.json")).stdout.trim()).toBe("600");
    expect((await inC("test -d ~/.wtc-agent || echo gone")).stdout.trim()).toBe("gone");
    const hostJson = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const cj = JSON.parse((await inC("cat ~/.claude.json")).stdout);
    expect(Object.keys(cj.mcpServers ?? {}).sort()).toEqual(Object.keys(hostJson.mcpServers ?? {}).sort());
    expect(cj.projects["/workspace/app"].hasTrustDialogAccepted).toBe(true);
    const skills = join(homedir(), ".claude", "skills");
    for (const s of existsSync(skills) ? readdirSync(skills) : []) {
      if (!existsSync(join(skills, s, "SKILL.md"))) continue;
      expect((await inC(`test -f ~/.claude/skills/${s}/SKILL.md && echo ok`)).stdout.trim()).toBe("ok");
    }
    expect((await inC("find ~/.claude/plugins -name .git | head -1")).stdout.trim()).toBe("");
    expect((await inC("echo $PATH")).stdout.split(":")[0]).toBe("/wtc/bin");
    expect((await inC("echo $PNPM_CONFIG_STORE_DIR")).stdout.trim()).toBe("/pnpm/store");
  }, 5 * MIN);

  test("claude: no reinstall on second run; bad flag exit code passes through", async () => {
    const code = await w.agent("e2e", "claude", ["--definitely-not-a-flag"]);
    expect(code).not.toBe(0);
  }, 5 * MIN);

  test("codex: auto-installs, runs a real task in cwd", async () => {
    const code = await w.agent("e2e", "codex", ["exec", "--skip-git-repo-check",
      "Run this shell command exactly: printf CODEX_OK > codex.txt . Then reply done."]);
    expect(code).toBe(0);
    expect((await inC("cat /workspace/app/codex.txt")).stdout).toBe("CODEX_OK");
    expect((await inC("stat -c %a ~/.codex/auth.json")).stdout.trim()).toBe("600");
  }, 10 * MIN);
});
