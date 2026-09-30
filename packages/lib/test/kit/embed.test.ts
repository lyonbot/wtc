import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKit } from "../../src/kit/embed";

const cacheDir = mkdtempSync(join(tmpdir(), "wtc-embed-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

test("ensureKit extracts executables once", async () => {
  const dir = await ensureKit({ arch: "arm64", cacheDir });
  const names = ["wtc-entry", "wtc-signal", "wtc-install", "wtc-kit"];
  for (const n of names) expect(statSync(join(dir, n)).mode & 0o755).toBe(0o755);
  const before = names.map((n) => statSync(join(dir, n)).mtimeMs);
  await Bun.sleep(20);
  expect(await ensureKit({ arch: "arm64", cacheDir })).toBe(dir);
  expect(names.map((n) => statSync(join(dir, n)).mtimeMs)).toEqual(before);
  const amd = await ensureKit({ arch: "amd64", cacheDir });
  expect(amd).not.toBe(dir);
  expect(dir).toContain(`kit/`);
});
