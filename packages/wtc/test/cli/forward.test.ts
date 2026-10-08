import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLocalWtc } from "../../bin/forward.js";

const root = mkdtempSync(join(tmpdir(), "wtc-fwd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeSetup(name: string, localVersion?: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wtc.setup.ts"), "");
  if (localVersion) {
    const pkg = join(dir, "node_modules/@lyonbot/wtc");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: localVersion }));
    writeFileSync(join(pkg, "bin/wtc.js"), "");
  }
  return dir;
}
const find = (cwd: string, o: { argv?: string[]; env?: Record<string, string> } = {}) =>
  findLocalWtc({ argv: o.argv ?? [], env: o.env ?? {}, cwd, selfVersion: "2.0.0" });

test("forwards to a differing local version, found from a subdirectory", () => {
  const dir = makeSetup("a", "1.0.0");
  mkdirSync(join(dir, "sub"));
  const r = find(join(dir, "sub"));
  expect(r?.version).toBe("1.0.0");
  expect(r?.entry.endsWith("bin/wtc.js")).toBe(true);
});

test("same version, no local install, or no setup: run current", () => {
  expect(find(makeSetup("b", "2.0.0"))).toBeUndefined();
  expect(find(makeSetup("c"))).toBeUndefined();
  expect(find(root)).toBeUndefined();
});

test("--setup and WTC_SETUP choose the setup dir", () => {
  const dir = makeSetup("d", "1.0.0");
  expect(find(root, { argv: ["ls", "--setup", dir] })?.version).toBe("1.0.0");
  expect(find(root, { argv: [`--setup=${dir}`] })?.version).toBe("1.0.0");
  expect(find(root, { env: { WTC_SETUP: dir } })?.version).toBe("1.0.0");
});

test("opt-out and loop guard", () => {
  const dir = makeSetup("e", "1.0.0");
  expect(find(dir, { env: { WTC_NO_FORWARD: "1" } })).toBeUndefined();
  expect(find(dir, { env: { WTC_FORWARDED: "1" } })).toBeUndefined();
});

test("init never forwards (it creates a setup, the enclosing one is unrelated)", () => {
  const dir = makeSetup("f", "1.0.0");
  expect(find(dir, { argv: ["init", "sub"] })).toBeUndefined();
  expect(find(root, { argv: ["--setup", dir, "init"] })).toBeUndefined();
  expect(find(dir, { argv: ["ls", "init"] })?.version).toBe("1.0.0");
});
