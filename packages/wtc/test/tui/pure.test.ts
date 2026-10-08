import { describe, expect, test } from "bun:test";
import { fit, fmtBytes, fmtCpu, visLen } from "../../src/tui/format";
import { dropdown, formKey, newForm, validate } from "../../src/tui/form";
import { editLine, line, parseKeys } from "../../src/tui/keys";
import { defaultSel, listItems, renderList, type Row } from "../../src/tui/list";
import { buildMenu } from "../../src/tui/menu";

const row = (name: string, state: Row["state"] = "ready"): Row => ({ name, state, phase: "wait-ready" });
const names = (s: string) => parseKeys(s).map((k) => (k.name === "char" ? k.ch : k.name));

describe("keys", () => {
  test("parseKeys", () => {
    expect(names("ab")).toEqual(["a", "b"]);
    expect(names("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(names("\x1b")).toEqual(["esc"]);
    expect(names("\r\t\x7f\x03")).toEqual(["enter", "tab", "backspace", "ctrl-c"]);
    expect(names("\x1b[3~\x1b[Z")).toEqual(["delete", "shift-tab"]);
    expect(names("é中")).toEqual(["é", "中"]);
    expect(names("\x1b[99;9z")).toEqual([]); // unknown sequence dropped
  });
  test("editLine", () => {
    let l = line("ab");
    for (const k of parseKeys("c")) l = editLine(l, k)!;
    expect(l).toEqual({ text: "abc", cur: 3 });
    l = editLine(editLine(l, { name: "left" })!, { name: "backspace" })!;
    expect(l).toEqual({ text: "ac", cur: 1 });
    expect(editLine(line("foo bar"), { name: "ctrl-w" })).toEqual({ text: "foo ", cur: 4 });
    expect(editLine(line("foo"), { name: "ctrl-u" })).toEqual({ text: "", cur: 0 });
    expect(editLine(line("x"), { name: "enter" })).toBeNull();
  });
});

describe("format", () => {
  test("fit ignores ANSI width and resets on cut", () => {
    expect(visLen("\x1b[1mhello\x1b[0m")).toBe(5);
    expect(visLen(fit("\x1b[1mhello world\x1b[0m", 5))).toBe(5);
    expect(fit("short", 10)).toBe("short");
  });
  test("bytes and cpu", () => {
    expect(fmtBytes(undefined)).toBe("-");
    expect(fmtBytes(512)).toBe("512B");
    expect(fmtBytes(256 * 1024 ** 2)).toBe("256M");
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe("1.5G");
    expect(fmtCpu(undefined)).toBe("-");
    expect(fmtCpu(3.14)).toBe("3.1%");
    expect(fmtCpu(42.6)).toBe("43%");
  });
});

describe("list", () => {
  const rows = [row("alpha"), row("beta"), row("alps")];
  test("filter is case-insensitive substring; create row is always last", () => {
    const its = listItems(rows, "AL");
    expect(its.map((i) => (i.kind === "create" ? "+" : i.row.name))).toEqual(["alpha", "alps", "+"]);
    expect(listItems([], "").map((i) => i.kind)).toEqual(["create"]);
  });
  test("create row carries the filter only when it is a valid name", () => {
    expect(listItems(rows, "new-one").at(-1)).toEqual({ kind: "create", name: "new-one" });
    expect(listItems(rows, "Bad Name!").at(-1)).toEqual({ kind: "create", name: "" });
    expect(listItems(rows, "").at(-1)).toEqual({ kind: "create", name: "" });
  });
  test("default selection: first match, or the create row when nothing matches", () => {
    expect(defaultSel(listItems(rows, "al"))).toBe(0);
    expect(defaultSel(listItems(rows, "zzz"))).toBe(0); // only the create row
    expect(defaultSel(listItems([], ""))).toBe(0);
  });
  test("renderList shows count, stats and create label within the given size", () => {
    const rs: Row[] = [{ ...row("alpha"), cpu: 12.3, mem: 300 * 1024 ** 2 }, row("beta", "stopped")];
    const out = renderList({ setupId: "demo", rows: rs, filter: line("be"), sel: 0, msg: "", loaded: true }, 80, 12);
    const text = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toHaveLength(12);
    expect(text).toContain("2 instances · 1 ready");
    expect(text).toContain('+ create "be"');
    expect(text).toContain("beta");
    expect(text).not.toContain("alpha");
    expect(text).toContain("filter be");
  });
});

describe("menu", () => {
  const m = {
    scripts: { "restart-dev-server": { run: "x", description: "restart" } },
    hostScripts: { chrome: { run: "./chrome.sh", description: "open chrome" } },
  };
  test("fixed shortcuts, script shortcuts avoid collisions, tags show where scripts run", () => {
    const items = buildMenu(m, row("a"));
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(Object.keys(byKey)).toHaveLength(items.length); // all unique
    expect(byKey.s!.action).toEqual({ type: "shell" });
    expect(byKey.c!.action).toEqual({ type: "open", editor: "cursor" });
    const chrome = items.find((i) => i.action.type === "script" && i.action.script === "chrome")!;
    expect(chrome.tag).toBe("host");
    expect(chrome.key).toBe("h"); // "c" is taken by Cursor
    const restart = items.find((i) => i.action.type === "script" && i.action.script === "restart-dev-server")!;
    expect(restart.tag).toBe("container");
    expect(["s", "c", "v", "i", "d", "h"]).not.toContain(restart.key);
  });
  test("stopped instances get no shell or scripts", () => {
    const keys = buildMenu(m, row("a", "stopped")).map((i) => i.action.type);
    expect(keys).toEqual(["open", "open", "inspect", "delete"]);
  });
});

describe("form", () => {
  const params = {
    BRANCH: { description: "branch", default: "master", suggest: () => [] as string[] },
    FLAG: { description: "flag", default: "", pattern: "^(1|true)?$" },
    NEED: { description: "required", required: true },
  };
  test("starts on the first empty field (name) or on params when the name is prefilled", () => {
    expect(newForm({ params }, "").focus).toBe(0);
    expect(newForm({ params }, "x1").focus).toBe(1);
    expect(newForm({ params }, "x1").fields[1]!.value.text).toBe("master");
  });
  test("validate: name, required, pattern", () => {
    let f = newForm({ params }, "Bad Name");
    expect(validate(f)!.focus).toBe(0);
    f = newForm({ params }, "ok");
    expect(validate(f)).toMatchObject({ focus: 3, message: "NEED is required" });
    f = { ...f, fields: f.fields.map((x) => (x.key === "NEED" ? { ...x, value: line("v") } : x.key === "FLAG" ? { ...x, value: line("0") } : x)) };
    expect(validate(f)).toMatchObject({ focus: 2 });
  });
  test("dropdown filters, hides on exact match; Tab completes; focusing a suggestible field asks the app to fetch", () => {
    let f = newForm({ params }, "ok"); // focus BRANCH
    f = { ...f, suggestions: { BRANCH: ["master", "chore/pnpm1", "feat/flow"] }, hi: 0, fields: f.fields.map((x) => (x.key === "BRANCH" ? { ...x, value: line("fl"), fresh: false } : x)) };
    expect(dropdown(f)).toEqual(["feat/flow"]);
    const [f2] = formKey(f, { name: "tab" });
    expect(f2.fields[1]!.value.text).toBe("feat/flow");
    expect(dropdown(f2)).toEqual([]); // exact match hides the list
    const [, r] = formKey({ ...f2, focus: 0 }, { name: "down" });
    expect(r).toEqual({ type: "focus", key: "BRANCH" });
  });
  test("an untouched default is replaced by typing; the dropdown lists all candidates but Tab moves on until you pick with ↓", () => {
    let f = newForm({ params }, "ok");
    f = { ...f, suggestions: { BRANCH: ["master", "chore/pnpm1", "feat/flow"] } };
    expect(dropdown(f)).toEqual(["master", "chore/pnpm1", "feat/flow"]);
    expect(formKey(f, { name: "tab" })[0].focus).toBe(2); // not completing: nothing highlighted
    const [picked] = formKey(formKey(f, { name: "down" })[0], { name: "down" }); // master -> chore/pnpm1
    expect(formKey(picked, { name: "tab" })[0].fields[1]!.value.text).toBe("chore/pnpm1");
    const [typed] = formKey(f, { name: "char", ch: "f" });
    expect(typed.fields[1]!.value.text).toBe("f"); // replaced, not appended
    expect(dropdown(typed)).toEqual(["feat/flow"]);
    expect(formKey(f, { name: "backspace" })[0].fields[1]!.value.text).toBe("");
  });
  test("Ctrl-S submits with only non-empty params; invalid submit keeps the form and reports", () => {
    let f = newForm({ params }, "ok");
    const [bad, r0] = formKey(f, { name: "ctrl-s" });
    expect(r0).toEqual({ type: "none" });
    expect(bad.error).toBe("NEED is required");
    f = { ...bad, fields: bad.fields.map((x) => (x.key === "NEED" ? { ...x, value: line("v") } : x)) };
    const [, r] = formKey(f, { name: "ctrl-s" });
    expect(r).toEqual({ type: "submit", name: "ok", set: { BRANCH: "master", NEED: "v" } });
    expect(formKey(f, { name: "esc" })[1]).toEqual({ type: "cancel" });
  });
});
