import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderLs, renderSummary } from "../../src/cli/render";
import { instancePaths } from "../../src/instance/create-spec";
import { ls, up } from "../../src/instance/instance";
import { dropTrailingNewlines, getRemark, plainRemark, remarkHead, setRemark } from "../../src/ops/remark";
import { line } from "../../src/tui/keys";
import { remarkDetail, renderList, type Row } from "../../src/tui/list";
import { collect, mkCtx } from "../instance/helpers";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));
async function setup() {
  const t = mkCtx();
  cleanups.push(t.cleanup);
  await collect(up(t.ctx, "a", { wait: false }));
  return t;
}

/** FakeRuntime has no container: run the real kit script on the instance's run dir for `wtc-remark` execs. */
function bridgeKit(t: Awaited<ReturnType<typeof setup>>) {
  const execs: string[][] = [];
  t.rt.execHandler = (_n, cmd, o) => {
    execs.push(cmd);
    const r = spawnSync("bash", [kitScript, ...cmd.slice(1)], { env: { ...process.env, WTC_RUN: instancePaths(t.dir, "a").run }, input: o?.input ?? "", encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return execs;
}
const kitScript = join(import.meta.dir, "../../../../kit/bin/wtc-remark");

describe("host remark ops", () => {
  test("running container: written through its wtc-remark; stopped container: written by the host", async () => {
    const t = await setup();
    const execs = bridgeKit(t);
    expect((await t.rt.inspect("wtc-demo--a"))?.state).toBe("running");
    expect(await setRemark(t.ctx, "a", "via container\nok\n")).toBe("via container\nok");
    expect(execs).toEqual([["/wtc/bin/wtc-remark", "-"]]);
    expect(await getRemark(t.ctx, "a")).toBe("via container\nok");
    await setRemark(t.ctx, "a", "");
    expect(execs.at(-1)).toEqual(["/wtc/bin/wtc-remark", "--clear"]);
    expect(await getRemark(t.ctx, "a")).toBeUndefined();
    await t.rt.stop("wtc-demo--a");
    expect(await setRemark(t.ctx, "a", "while stopped")).toBe("while stopped");
    expect(execs).toHaveLength(2);
    expect(readFileSync(instancePaths(t.dir, "a").remark, "utf8")).toBe("while stopped");
  });

  test("a failing exec falls back to the host write", async () => {
    const t = await setup();
    const opts: unknown[] = [];
    t.rt.execHandler = (_n, _c, o) => (opts.push(o), { exitCode: 1, stdout: "", stderr: "boom" });
    expect(await setRemark(t.ctx, "a", "fallback")).toBe("fallback");
    expect(opts[0]).toMatchObject({ timeoutMs: 15_000 }); // a hung exec (killed on timeout) falls back too
    expect(readFileSync(instancePaths(t.dir, "a").remark, "utf8")).toBe("fallback");
  });

  test("the file exists (empty) right after create", async () => {
    const t = await setup();
    expect(readFileSync(instancePaths(t.dir, "a").remark, "utf8")).toBe("");
    expect(await getRemark(t.ctx, "a")).toBeUndefined();
  });

  test("set / get / clear, multi-line and unbounded, trailing newlines dropped", async () => {
    const t = await setup();
    bridgeKit(t);
    const big = "x".repeat(100_000);
    expect(await setRemark(t.ctx, "a", `line1\nline2 ${big}\n\n`)).toBe(`line1\nline2 ${big}`);
    expect(await getRemark(t.ctx, "a")).toBe(`line1\nline2 ${big}`);
    expect(await setRemark(t.ctx, "a", "")).toBeUndefined();
    expect(readFileSync(instancePaths(t.dir, "a").remark, "utf8")).toBe(""); // truncated, never deleted (colima stale-view bug)
    expect(await getRemark(t.ctx, "a")).toBeUndefined();
  });

  test("missing instance is NOT_FOUND", async () => {
    const t = await setup();
    await expect(setRemark(t.ctx, "nope", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getRemark(t.ctx, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("ls / summary carry the remark and the renderers show it", async () => {
    const t = await setup();
    bridgeKit(t);
    await setRemark(t.ctx, "a", "fixing login\nsecond line");
    const [s] = await ls(t.ctx);
    expect(s!.remark).toBe("fixing login\nsecond line");
    expect(renderLs([s!])).toContain("fixing login…");
    expect(renderSummary(s!)).toContain("remark:  fixing login\n         second line");
  });
});

describe("display helpers", () => {
  test("plainRemark strips control characters but keeps newlines", () => {
    expect(plainRemark("a\x1b[31mred\x1b[0m\tb\r\nc\x07")).toBe("a[31mred[0m b\nc");
  });
  test("a long run of newlines is trimmed in linear time (the file is container-writable)", async () => {
    const t = await setup();
    const file = instancePaths(t.dir, "a").remark;
    writeFileSync(file, "\n".repeat(300_000) + "x\r\n\n");
    const t0 = performance.now();
    expect(await getRemark(t.ctx, "a")).toHaveLength(300_001);
    expect(dropTrailingNewlines("\r\n".repeat(300_000) + "y")).toHaveLength(600_001);
    expect(performance.now() - t0).toBeLessThan(500); // the old /[\r\n]+$/ took seconds here
    expect(dropTrailingNewlines("a\n\r\n")).toBe("a");
    expect(dropTrailingNewlines("\n\n")).toBe("");
  });
  test("remarkHead", () => {
    expect(remarkHead(undefined)).toBe("-");
    expect(remarkHead("one")).toBe("one");
    expect(remarkHead("one\ntwo")).toBe("one…");
  });
});

describe("tui", () => {
  const row = (name: string, remark?: string): Row => ({ name, state: "ready", phase: null, ...(remark ? { remark } : {}) });
  const strip = (l: string[]) => l.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  test("remarkDetail wraps and caps with an ellipsis", () => {
    expect(remarkDetail("a".repeat(25), 12)).toEqual(["a".repeat(10), "a".repeat(10), "aaaaa"]);
    const d = remarkDetail(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), 40);
    expect(d).toHaveLength(6);
    expect(d.at(-1)).toBe("…");
  });
  test("column shows the head; the selected row's full remark appears at the bottom", () => {
    const rows = [row("alpha", "doing X\nstep 2 of 3"), row("beta", "other note")];
    const sel0 = renderList({ setupId: "d", rows, filter: line(""), sel: 0, msg: "", loaded: true }, 80, 14);
    expect(sel0).toHaveLength(14);
    const t0 = strip(sel0);
    expect(t0).toContain("doing X…");
    expect(t0).toContain("─ remark ─\ndoing X\nstep 2 of 3");
    const sel1 = strip(renderList({ setupId: "d", rows, filter: line(""), sel: 1, msg: "", loaded: true }, 80, 14));
    expect(sel1).toContain("─ remark ─\nother note");
    expect(sel1).not.toContain("step 2 of 3");
    const none = strip(renderList({ setupId: "d", rows: [row("gamma")], filter: line(""), sel: 0, msg: "", loaded: true }, 80, 14));
    expect(none).not.toContain("─ remark ─");
  });
  test("on a short screen the detail shrinks so the selected row, msg and help line stay visible", () => {
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    for (const h of [8, 10, 12]) {
      const out = renderList({ setupId: "d", rows: [row("alpha", long)], filter: line(""), sel: 0, msg: "hello", loaded: true }, 80, h);
      expect(out).toHaveLength(h);
      const t = strip(out);
      expect(t).toContain("> alpha");
      expect(t).toContain("hello\ntype to filter");
    }
    expect(strip(renderList({ setupId: "d", rows: [row("alpha", long)], filter: line(""), sel: 0, msg: "", loaded: true }, 80, 7))).not.toContain("─ remark ─");
  });
});

describe("kit/bin/wtc-remark", () => {
  const script = kitScript;
  const run = (dir: string, args: string[], input?: string) =>
    spawnSync("bash", [script, ...args], { env: { ...process.env, WTC_RUN: dir }, ...(input !== undefined ? { input } : {}), encoding: "utf8" });
  test("set / print / stdin / clear, same format as the host", async () => {
    const t = await setup();
    bridgeKit(t);
    const dir = instancePaths(t.dir, "a").run;
    expect(run(dir, []).stdout).toBe("");
    expect(run(dir, ["running", "tests"]).status).toBe(0);
    expect(run(dir, []).stdout).toBe("running tests\n");
    expect(await getRemark(t.ctx, "a")).toBe("running tests");
    expect(run(dir, ["-"], "multi\nline\n\n").status).toBe(0);
    expect(readFileSync(join(dir, "remark"), "utf8")).toBe("multi\nline");
    await setRemark(t.ctx, "a", "from host\nok");
    expect(run(dir, []).stdout).toBe("from host\nok\n");
    expect(run(dir, ["--clear"]).status).toBe(0);
    expect(readFileSync(join(dir, "remark"), "utf8")).toBe("");
    expect(run(dir, []).stdout).toBe("");
  });
});

describe("tui remark box", () => {
  test("Enter saves the whole text; Esc cancels; Ctrl-G asks for the editor; resolveEditor", async () => {
    const { newRemarkEdit, remarkKey, resolveEditor } = await import("../../src/tui/remark");
    const dims = { width: 40, rows: 5 };
    let s = newRemarkEdit("a", "l1\nl2");
    expect(s.ta.text).toBe("l1\nl2");
    s = remarkKey(s, { name: "char", ch: "x" }, dims)[0];
    expect(remarkKey(s, { name: "enter" }, dims)[1]).toEqual({ type: "save", text: "l1\nl2x" });
    expect(remarkKey(s, { name: "esc" }, dims)[1]).toEqual({ type: "cancel" });
    expect(remarkKey(s, { name: "ctrl-g" }, dims)[1]).toEqual({ type: "editor" });
    expect(resolveEditor({ EDITOR: "code -w" }, () => null)).toBe("code -w");
    expect(resolveEditor({}, () => "/usr/bin/vi")).toBe("vi");
    expect(resolveEditor({}, () => null)).toBeNull();
  });
  test("control characters in the stored remark are not loaded into the box", async () => {
    const { newRemarkEdit } = await import("../../src/tui/remark");
    expect(newRemarkEdit("a", "ok\x1b[31mred").ta.text).toBe("ok[31mred");
  });
});

describe("tui runEditor", () => {
  test("runs the editor command line on a temp file seeded with the text and returns the result", async () => {
    const { runEditor } = await import("../../src/tui/remark");
    // the "editor" appends a line to the file it is given
    const r = await runEditor(`sh -c 'printf "%s\\n" "added" >> "$0"'`, "seed");
    expect(r).toEqual({ code: 0, text: "seed\nadded" });
    expect((await runEditor("false", "x")).code).not.toBe(0);
  });
});
