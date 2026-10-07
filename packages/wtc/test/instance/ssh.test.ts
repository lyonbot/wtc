import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSshDir } from "../../src/instance/ssh";

const root = mkdtempSync(join(tmpdir(), "wtc-ssh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
mkdirSync(join(home, ".ssh"), { recursive: true });
const GH = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
writeFileSync(join(home, ".ssh", "known_hosts"), `other.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n${GH}\n`);

const CONFIG = "Host *\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ~/.ssh/known_hosts\n";

describe("prepareSshDir", () => {
  test("writes config and extracts known hosts; missing host -> warning", async () => {
    const dir = join(root, "out1");
    const r = await prepareSshDir({ dir, knownHosts: ["github.com", "gitlab.example"], home });
    expect(readFileSync(join(dir, "config"), "utf8")).toBe(CONFIG);
    expect(readFileSync(join(dir, "known_hosts"), "utf8")).toBe(`${GH}\n`);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("gitlab.example");
  });
  test("no knownHosts -> config + empty known_hosts, no warnings", async () => {
    const dir = join(root, "out2");
    const r = await prepareSshDir({ dir, knownHosts: [], home: join(root, "nohome") });
    expect(readFileSync(join(dir, "config"), "utf8")).toBe(CONFIG);
    expect(readFileSync(join(dir, "known_hosts"), "utf8")).toBe("");
    expect(r.warnings).toEqual([]);
  });
});
