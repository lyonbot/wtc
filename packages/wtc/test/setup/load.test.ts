import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSetup, resolveSetupDir } from "../../src/setup/load";
import { WtcError } from "../../src/errors";

const fx = join(import.meta.dir, "..", "fixtures", "basic");
const tmp = mkdtempSync(join(tmpdir(), "wtc-load-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function mk(name: string, src: string) {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "wtc.setup.ts"), src);
  return d;
}
const code = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as WtcError | null;

describe("loadSetup", () => {
  test("loads fixture with defaults", async () => {
    const s = await loadSetup(fx);
    expect(s.dir).toBe(fx);
    expect(s.manifest.id).toBe("basic");
    expect(s.manifest.socksPort).toBe(1080);
  });
  test("invalid manifest -> INVALID_MANIFEST", async () => {
    const e = await code(loadSetup(mk("inv", `export default { id: "Bad" };`)));
    expect(e?.code).toBe("INVALID_MANIFEST");
  });
  test("missing file -> SETUP_NOT_FOUND", async () => {
    expect((await code(loadSetup(join(tmp, "none"))))?.code).toBe("SETUP_NOT_FOUND");
  });
});

describe("resolveSetupDir", () => {
  test("walks up from nested dir", () => {
    const nested = join(fx, "scripts");
    expect(resolveSetupDir({ cwd: nested })).toBe(fx);
  });
  test("flag wins over env", () => {
    expect(resolveSetupDir({ flag: fx, env: "/nope", cwd: "/" })).toBe(fx);
    expect(resolveSetupDir({ env: fx, cwd: "/" })).toBe(fx);
  });
  test("not found", () => {
    expect(() => resolveSetupDir({ cwd: tmp })).toThrow(WtcError);
  });
});
