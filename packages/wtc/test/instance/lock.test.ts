import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCreate, acquireGc, lockDir } from "../../src/instance/lock";

const root = mkdtempSync(join(tmpdir(), "wtc-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const setup = (n: string) => join(root, n);
const files = (d: string) => readdirSync(lockDir(d)).sort();
const plant = async (d: string, f: string, body: string) => {
  await mkdir(lockDir(d), { recursive: true });
  writeFileSync(join(lockDir(d), f), body);
};
const holder = (pid: number) => JSON.stringify({ pid, op: "planted", since: "then" });
const dead = () => false;

test("gc refuses during a create, naming the lock file; passes once released", async () => {
  const d = setup("a");
  const rel = await acquireCreate(d, "x");
  const [lease] = files(d);
  expect(lease).toMatch(/^create\.x\..+\.lock$/);
  const err = await acquireGc(d).catch((e) => e);
  expect(err).toMatchObject({ code: "LOCKED" });
  expect(err.message).toContain(join(lockDir(d), lease!));
  expect(files(d)).toEqual([lease!]); // gc backed out its own file
  await rel();
  await (await acquireGc(d))();
  expect(files(d)).toEqual([]);
});

test("create waits for gc, then fails with LOCKED naming the gc lock file", async () => {
  const d = setup("b");
  const rel = await acquireGc(d);
  const [g] = files(d);
  const err = await acquireCreate(d, "x", { waitMs: 300 }).catch((e) => e);
  expect(err).toMatchObject({ code: "LOCKED" });
  expect(err.message).toContain(join(lockDir(d), g!));
  expect(files(d)).toEqual([g!]);
  await rel();
});

test("create proceeds when gc finishes while it waits", async () => {
  const d = setup("c");
  const rel = await acquireGc(d);
  setTimeout(() => void rel(), 300);
  await (await acquireCreate(d, "x", { waitMs: 5000 }))();
});

test("concurrent creates (same or different name) hold separate leases; a second gc is refused", async () => {
  const d = setup("d");
  const r1 = await acquireCreate(d, "x");
  const r2 = await acquireCreate(d, "x");
  const r3 = await acquireCreate(d, "y");
  expect(files(d)).toHaveLength(3);
  await r1(); // must not drop the other `x` lease
  await expect(acquireGc(d)).rejects.toMatchObject({ code: "LOCKED" });
  await r2();
  await r3();
  const g = await acquireGc(d);
  await expect(acquireGc(d)).rejects.toMatchObject({ code: "LOCKED", message: expect.stringContaining("another gc") });
  expect(files(d)).toHaveLength(1);
  await g();
});

test("stale (dead pid) and corrupt lock files are removed, never wedge", async () => {
  const d = setup("e");
  await plant(d, "create.x.1.lock", holder(999999));
  await plant(d, "create.y.1.lock", "");
  await plant(d, "create.z.1.lock", holder(0)); // pid 0 would signal our own process group
  await (await acquireGc(d, dead))();
  expect(files(d)).toEqual([]);
  await plant(d, "gc.1.lock", holder(999999));
  await plant(d, "gc.2.lock", "{\"pid\":");
  await (await acquireCreate(d, "y", { alive: dead, waitMs: 0 }))();
  expect(files(d)).toEqual([]);
});

test("a live pid owned by another user (EPERM) counts as a holder", async () => {
  const d = setup("f");
  await plant(d, "create.x.1.lock", holder(1)); // launchd / init: kill(1, 0) -> EPERM
  await expect(acquireGc(d)).rejects.toMatchObject({ code: "LOCKED" });
});
