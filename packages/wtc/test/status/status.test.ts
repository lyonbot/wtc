import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeState, readStatus, watchStatus, type StatusFile } from "../../src/status/status";
import type { ContainerInfo } from "../../src/runtime/types";

const c = (o: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: "1", name: "n", image: "i", labels: {}, state: "running", startedAt: "2026-09-30T10:15:06.023082545Z", ...o,
});
const s = (o: Partial<StatusFile> = {}): StatusFile => ({
  bootId: "b1", startedAt: "2026-09-30T10:15:06.023Z", state: "ready", phase: "start", history: [], ...o,
});
const tmp = () => mkdtempSync(join(tmpdir(), "wtc-status-"));

describe("mergeState", () => {
  test("absent", () => expect(mergeState(null, s())).toEqual({ state: "absent", phase: null, stale: false }));
  test("stopped", () => {
    for (const st of ["exited", "created", "paused", "dead"] as const)
      expect(mergeState(c({ state: st }), s()).state).toBe("stopped");
  });
  test("no status -> booting stale", () =>
    expect(mergeState(c(), null)).toEqual({ state: "booting", phase: null, stale: true }));
  test("older status -> booting stale", () => {
    const m = mergeState(c(), s({ startedAt: "2026-09-30T10:15:05.999Z", state: "ready" }));
    expect(m).toMatchObject({ state: "booting", phase: null, stale: true });
  });
  test("same ms is fresh (ns truncated)", () =>
    expect(mergeState(c(), s()).stale).toBe(false));
  test("restarting counts as running", () =>
    expect(mergeState(c({ state: "restarting" }), s({ state: "booting", phase: "clone" }))).toMatchObject({ state: "booting", phase: "clone", stale: false }));
  test("ready", () => expect(mergeState(c(), s())).toMatchObject({ state: "ready", bootId: "b1", stale: false }));
  test("failed carries details", () =>
    expect(mergeState(c(), s({ state: "failed", phase: "install", message: "boom", exitCode: 3, reason: "exit" })))
      .toEqual({ state: "failed", phase: "install", message: "boom", exitCode: 3, reason: "exit", bootId: "b1", stale: false }));
});

describe("readStatus", () => {
  test("missing/invalid -> null", async () => {
    const d = tmp();
    expect(await readStatus(join(d, "nope.json"))).toBeNull();
    writeFileSync(join(d, "bad.json"), "{oops");
    expect(await readStatus(join(d, "bad.json"))).toBeNull();
  });
  test("valid", async () => {
    const d = tmp();
    writeFileSync(join(d, "s.json"), JSON.stringify(s()));
    expect((await readStatus(join(d, "s.json")))?.bootId).toBe("b1");
  });
});

describe("watchStatus", () => {
  test("yields initial and on change, stops on abort", async () => {
    const d = tmp();
    const f = join(d, "status.json");
    const ac = new AbortController();
    const got: (string | null)[] = [];
    const done = (async () => {
      for await (const v of watchStatus(f, { intervalMs: 10, signal: ac.signal })) {
        got.push(v ? v.state : null);
        if (got.length === 3) ac.abort();
      }
    })();
    await Bun.sleep(40);
    writeFileSync(f + ".tmp", JSON.stringify(s({ state: "booting" })));
    renameSync(f + ".tmp", f);
    await Bun.sleep(40);
    writeFileSync(f + ".tmp", JSON.stringify(s({ state: "ready" })));
    renameSync(f + ".tmp", f);
    await done;
    expect(got).toEqual([null, "booting", "ready"]);
  });
  test("ends when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const got = [];
    for await (const v of watchStatus("/nonexistent", { intervalMs: 5, signal: ac.signal })) got.push(v);
    expect(got).toEqual([]);
  });
});
