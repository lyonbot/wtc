import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSetupId, initSetup, loadSetup } from "../../src/index";
import { WTC_VERSION } from "../../src/version";

const root = mkdtempSync(join(tmpdir(), "wtc-init-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("scaffolds a setup that loads and validates", async () => {
  const dir = join(root, "My_App");
  const r = await initSetup({ dir });
  expect(r.id).toBe("my-app");
  expect(r.created).toContain("wtc.setup.ts");
  expect((await loadSetup(dir)).manifest.id).toBe("my-app");
  expect(statSync(join(dir, "init.sh")).mode & 0o111).toBeTruthy();
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["@lyonbot/wtc"]).toBe(`^${WTC_VERSION}`);
});

test("refuses to overwrite and writes nothing", async () => {
  const dir = join(root, "clash");
  mkdirSync(dir);
  writeFileSync(join(dir, "init.sh"), "mine");
  await expect(initSetup({ dir })).rejects.toMatchObject({ code: "SETUP_EXISTS" });
  expect(existsSync(join(dir, "wtc.setup.ts"))).toBe(false);
  expect(readFileSync(join(dir, "init.sh"), "utf8")).toBe("mine");
});

test("refuses a dir that is a file", async () => {
  const f = join(root, "file");
  writeFileSync(f, "");
  await expect(initSetup({ dir: f })).rejects.toMatchObject({ code: "SETUP_EXISTS" });
});

test("relative dir resolves against cwd", async () => {
  const prev = process.cwd();
  process.chdir(root);
  try {
    const r = await initSetup({ dir: "rel/sub" });
    expect(r.dir).toBe(join(realpathSync(root), "rel", "sub"));
    expect(r.id).toBe("sub");
  } finally {
    process.chdir(prev);
  }
});

test("id: explicit must be valid, default is slugified", async () => {
  await expect(initSetup({ dir: join(root, "x"), id: "Bad_Id" })).rejects.toMatchObject({ code: "INVALID_ID" });
  await expect(initSetup({ dir: join(root, "x"), id: "" })).rejects.toMatchObject({ code: "INVALID_ID" });
  expect(existsSync(join(root, "x"))).toBe(false);
  expect(defaultSetupId("/a/___")).toBe("app");
  expect(defaultSetupId("/a/Foo Bar.git")).toBe("foo-bar-git");
});
