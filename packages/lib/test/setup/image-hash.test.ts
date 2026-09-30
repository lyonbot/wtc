import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSetup } from "../../src/setup/load";
import { computeImageHash } from "../../src/setup/image-hash";

const fx = join(import.meta.dir, "..", "fixtures", "basic");
const tmp = mkdtempSync(join(tmpdir(), "wtc-hash-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
async function copy() {
  const d = join(tmp, `c${n++}`);
  cpSync(fx, d, { recursive: true });
  return loadSetup(d);
}

describe("computeImageHash", () => {
  test("stable, 12 hex", async () => {
    const a = await computeImageHash(await loadSetup(fx));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(await computeImageHash(await loadSetup(fx))).toBe(a);
  });
  test("changes with context file", async () => {
    const s = await copy();
    const a = await computeImageHash(s);
    writeFileSync(join(s.dir, "image", "a.txt"), "changed");
    expect(await computeImageHash(s)).not.toBe(a);
  });
  test("changes with buildArgs", async () => {
    const s = await copy();
    const a = await computeImageHash(s);
    s.manifest.image.buildArgs = { X: "1" };
    expect(await computeImageHash(s)).not.toBe(a);
  });
  test("unchanged by init.sh or scripts/", async () => {
    const s = await copy();
    const a = await computeImageHash(s);
    writeFileSync(join(s.dir, "init.sh"), "changed");
    writeFileSync(join(s.dir, "scripts", "s.sh"), "changed");
    expect(await computeImageHash(s)).toBe(a);
  });
});
