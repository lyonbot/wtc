import { describe, expect, test } from "bun:test";
import { parseKeys, line, editLine, type Key } from "../../src/tui/keys";
import { cursorRow, editTextArea, layout, renderTextArea, scrollTop, textarea, type TextArea } from "../../src/tui/textarea";

const names = (s: string) => parseKeys(s).map((k) => (k.name === "char" ? k.ch : k.name));
const strip = (l: string[]) => l.map((x) => x.replace(/\x1b\[[0-9;]*m/g, ""));
/** feed keys (names or `{ch}`) into an editor starting at `t` */
const type = (t: TextArea, keys: (string | Key)[], width = 20): TextArea =>
  keys.reduce<TextArea>((acc, k) => editTextArea(acc, typeof k === "string" ? { name: k } : k, width) ?? acc, t);
const chars = (s: string): Key[] => [...s].map((ch) => ({ name: "char", ch }));
const at = (text: string, cur: number): TextArea => ({ ...textarea(text), cur });

describe("parseKeys: modifiers, CSI u, paste", () => {
  test("Alt combinations and Ctrl-J / Alt-Enter", () => {
    expect(names("\x1bb\x1bf\x1bd")).toEqual(["alt-b", "alt-f", "alt-d"]);
    expect(names("\x1b\r\x1b\n\n")).toEqual(["newline", "newline", "newline"]);
    expect(names("\x1b\x7f")).toEqual(["alt-backspace"]);
    expect(names("\x0b\x19\x0a")).toEqual(["ctrl-k", "ctrl-y", "newline"]);
    expect(names("\x1b")).toEqual(["esc"]);
    expect(names("\x1b[A\x1b")).toEqual(["up", "esc"]);
    expect(names("\x1b\x03")).toEqual(["esc", "ctrl-c"]); // Esc then Ctrl-C in one chunk still quits
    expect(names("\x1b\x1b")).toEqual(["esc", "esc"]);
  });
  test("modified arrows and keys reported by kitty / modifyOtherKeys", () => {
    expect(names("\x1b[1;5D\x1b[1;3C")).toEqual(["ctrl-left", "alt-right"]);
    expect(names("\x1b[13;5u")).toEqual(["newline"]); // kitty Ctrl-Enter
    expect(names("\x1b[27;5;13~")).toEqual(["newline"]); // xterm modifyOtherKeys Ctrl-Enter
    expect(names("\x1b[13;2u")).toEqual(["newline"]); // Shift-Enter
    expect(names("\x1b[99;5u\x1b[27;5;97~")).toEqual(["ctrl-c", "ctrl-a"]);
    expect(names("\x1b[98;3u")).toEqual(["alt-b"]);
    expect(names("\x1b[27u\x1b[91;5u\x1b[27;5;91~")).toEqual(["esc", "esc", "esc"]); // Esc, Ctrl-[ (kitty / modifyOtherKeys)
    expect(names("\x1b[106;5u\x1b[27;5;109~")).toEqual(["newline", "enter"]); // Ctrl-J / Ctrl-M under a key protocol
  });
  test("bracketed paste is one key and keeps newlines", () => {
    expect(parseKeys("a\x1b[200~x\ny z\x1b[201~b")).toEqual([{ name: "char", ch: "a" }, { name: "paste", ch: "x\ny z" }, { name: "char", ch: "b" }]);
  });
  test("single-line inputs take a paste as one line", () => {
    expect(editLine(line("ab"), { name: "paste", ch: "x\ny\r\nz" })).toEqual({ text: "abx y z", cur: 7 });
    expect(editLine(line(), { name: "paste", ch: "a\x1b[2Jb\x9b2Jc" })?.text).toBe("a[2Jb2Jc"); // C0 and C1 controls dropped
  });
});

describe("layout / wrapping", () => {
  test("breaks after a space, hard-breaks long words, keeps blank lines", () => {
    const rows = layout([..."hello world foo"], 8);
    expect(rows.map((r) => [..."hello world foo"].slice(r.start, r.end).join(""))).toEqual(["hello ", "world ", "foo"]);
    expect(layout([..."abcdefghij"], 4).map((r) => [r.start, r.end])).toEqual([[0, 4], [4, 8], [8, 10]]);
    expect(layout([..."a\n\nb"], 5).map((r) => [r.start, r.end, r.eol])).toEqual([[0, 1, true], [2, 2, true], [3, 4, true]]);
    expect(layout([], 5)).toEqual([{ start: 0, end: 0, eol: true }]);
  });
  test("wide characters count as two columns", () => {
    const cs = [..."中文测试中文"];
    expect(layout(cs, 6).map((r) => r.end - r.start)).toEqual([3, 3]);
  });
  test("a cursor on a wrap boundary belongs to the next row", () => {
    const rows = layout([..."abcdefgh"], 4);
    expect(cursorRow(rows, 4)).toBe(1);
    expect(cursorRow(rows, 8)).toBe(1); // end of text
  });
});

describe("editing keys", () => {
  test("typing, Ctrl-J newline, backspace, delete, paste", () => {
    let t = type(textarea(), [...chars("ab"), "newline", ...chars("cd")]);
    expect(t).toMatchObject({ text: "ab\ncd", cur: 5 });
    t = type(t, ["left", "backspace", "delete"]);
    expect(t.text).toBe("ab\n");
    t = type(t, [{ name: "paste", ch: "x\r\ny\tz\x1b[0m" }]);
    expect(t.text).toBe("ab\nx\ny z[0m");
  });
  test("Ctrl-A / Ctrl-E move within the logical line, Home / End too", () => {
    const t = at("one\ntwo three", 8);
    expect(type(t, ["ctrl-a"]).cur).toBe(4);
    expect(type(t, ["ctrl-e"]).cur).toBe(13);
    expect(type(at("one\ntwo", 1), ["end"]).cur).toBe(3);
  });
  test("Ctrl-K cuts to line end (or joins lines); Ctrl-U to line start; Ctrl-Y pastes the cut", () => {
    let t = type(at("hello world\nnext", 5), ["ctrl-k"]);
    expect(t).toMatchObject({ text: "hello\nnext", kill: " world" });
    t = type(t, ["ctrl-k"]); // at the end of the line: joins
    expect(t.text).toBe("hellonext");
    t = type(at("abc def", 7), ["ctrl-u"]);
    expect(t).toMatchObject({ text: "", kill: "abc def" });
    expect(type(t, ["ctrl-y", "ctrl-y"]).text).toBe("abc defabc def");
    expect(type(at("a\nbc", 2), ["ctrl-u"]).text).toBe("a\nbc"); // already at line start: no-op
  });
  test("word moves and deletes: Alt-B/F, Ctrl-arrows, Ctrl-W, Alt-D, Alt-Backspace", () => {
    const t = at("foo bar  baz", 12);
    expect(type(t, ["alt-b"]).cur).toBe(9);
    expect(type(t, ["alt-b", "alt-b"]).cur).toBe(4);
    expect(type(at("foo bar baz", 0), ["alt-f", "alt-f"]).cur).toBe(7);
    expect(type(at("foo bar baz", 0), ["ctrl-right"]).cur).toBe(3);
    expect(type(t, ["ctrl-w"]).text).toBe("foo bar  ");
    expect(type(t, ["alt-backspace"]).text).toBe("foo bar  ");
    expect(type(at("foo bar baz", 4), ["alt-d"]).text).toBe("foo  baz");
    expect(type(at("中文 word", 9), ["alt-b"]).cur).toBe(3);
  });
  test("up / down keep the column across wrapped rows and short lines", () => {
    // width 6: "abcdef" "ghij" are two logical lines
    let t = at("abcdef\nghij\nk", 5);
    t = type(t, ["down"], 6);
    expect(t.cur).toBe(11); // ghij has 4 columns: clamps to its end
    t = type(t, ["down"], 6);
    expect(t.cur).toBe(13); // "k"
    t = type(t, ["up", "up"], 6);
    expect(t.cur).toBe(5); // the goal column 5 is restored
    expect(type(t, ["up"], 6).cur).toBe(0); // first row: to the start
    expect(type(at("ab\ncd", 4), ["down"], 6).cur).toBe(5); // last row: to the end
    const wrapped = at("aaaa bbbb cccc", 12); // width 5 -> "aaaa " "bbbb " "cccc"
    expect(type(wrapped, ["up"], 5).cur).toBe(7);
    expect(type(wrapped, ["up", "up"], 5).cur).toBe(2);
  });
  test("non-editing keys are left to the caller", () => {
    expect(editTextArea(textarea("x"), { name: "enter" }, 10)).toBeNull();
    expect(editTextArea(textarea("x"), { name: "esc" }, 10)).toBeNull();
    expect(editTextArea(textarea("x"), { name: "ctrl-g" }, 10)).toBeNull();
  });
});

describe("render / scroll", () => {
  test("shows a cursor cell, wraps, and scrolls to keep the cursor row visible", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const t = textarea(text);
    const top = scrollTop(t, 20, 4, 0);
    expect(top).toBe(6);
    const r = renderTextArea(t, 20, 4, top);
    expect(r.total).toBe(10);
    expect(strip(r.lines)).toEqual(["  line 6", "  line 7", "  line 8", "  line 9 "]);
    expect(strip(renderTextArea(textarea("abc"), 20, 4, 0).lines)[0]).toBe("> abc ");
    expect(scrollTop({ ...t, cur: 0 }, 20, 4, top)).toBe(0); // moving up scrolls back
  });
  test("the cursor cell after a row that fills the whole width is still drawn", () => {
    const l = renderTextArea(textarea("abcdefghij\nx"), 10, 4, 0).lines;
    expect(renderTextArea({ ...textarea("abcdefghij\nx"), cur: 10 }, 10, 4, 0).lines[0]).toContain("\x1b[7m \x1b[0m");
    expect(l[1]).toContain("\x1b[7m \x1b[0m"); // end of text
    expect(strip(renderTextArea(textarea("abcdefghij"), 10, 4, 0).lines)[0]).toBe("> abcdefghij ");
  });
});

describe("character width, graphemes, CJK words", () => {
  const { visLen, fit, clip, graphemes } = require("../../src/tui/format") as typeof import("../../src/tui/format");
  const { remarkDetail, renderList } = require("../../src/tui/list") as typeof import("../../src/tui/list");
  const { newRemarkEdit, renderRemarkEdit, boxDims } = require("../../src/tui/remark") as typeof import("../../src/tui/remark");

  test("display width: CJK and emoji are two columns, accents zero, ANSI ignored", () => {
    expect(visLen("中文ab")).toBe(6);
    expect(visLen("é")).toBe(1);
    expect(visLen("👨‍👩‍👧")).toBe(2);
    expect(visLen("\x1b[31m中\x1b[0m")).toBe(2);
    expect(visLen(fit("中文测试", 5))).toBeLessThanOrEqual(5);
    expect(fit("中文测试", 5).replace(/\x1b\[0m/, "")).toBe("中文"); // a wide char that does not fit is dropped
    expect(clip("中文测试", 5)).toBe("中文…");
    expect(clip("abc", 5)).toBe("abc");
    expect(graphemes("a👨‍👩‍👧é")).toHaveLength(3);
  });

  test("the cursor and Backspace treat an emoji sequence / accented letter as one character", () => {
    const fam = "👨‍👩‍👧";
    let t = type(textarea(`a${fam}`), ["left"]);
    expect(t.cur).toBe(1); // one step over the whole family
    expect(type(textarea(`a${fam}`), ["backspace"]).text).toBe("a");
    expect(type(textarea("é"), ["backspace"]).text).toBe("");
    // a combining mark typed after a letter merges into it: the cursor stays after the merged character
    t = type(textarea(), [{ name: "char", ch: "e" }, { name: "char", ch: "́" }, { name: "char", ch: "x" }]);
    expect(t).toMatchObject({ text: "éx", cur: 2 });
  });

  test("Alt-F / Alt-B / Ctrl-W / Alt-D segment Chinese and Japanese into words", () => {
    const zh = "今天修复登录问题";
    expect(type(at(zh, 0), ["alt-f"]).cur).toBe(2); // 今天
    expect(type(at(zh, 0), ["alt-f", "alt-f"]).cur).toBe(4); // 修复
    expect(type(at(zh, 8), ["alt-b"]).cur).toBe(6); // 问题
    expect(type(at(zh, 8), ["ctrl-w"]).text).toBe("今天修复登录");
    expect(type(at(zh, 0), ["alt-d"]).text).toBe("修复登录问题");
    expect(type(at("こんにちは世界", 0), ["alt-f"]).cur).toBe(5);
    expect(type(at("review，然后 PR", 0), ["alt-f", "alt-f"]).cur).toBe(9); // skips the full-width comma
    expect(type(at("foo_bar don't", 0), ["alt-f"]).cur).toBe(7); // underscore and apostrophe stay inside a word
  });

  test("wrapping a Chinese sentence fills rows by display width; the cursor row follows", () => {
    const cs = graphemes("今天修复登录问题然后提交");
    const rows = layout(cs, 10); // 5 characters per row
    expect(rows.map((r) => r.end - r.start)).toEqual([5, 5, 2]);
    expect(strip(renderTextArea(textarea("今天修复登录问题然后提交"), 10, 5, 0).lines).every((l) => visLen(l) <= 12)).toBe(true);
  });

  test("the box re-fits its scroll position when rendered after a resize", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const s = { ...newRemarkEdit("a", text), top: 0 }; // stale top: the cursor (end of text) is out of view
    const lines = strip(renderRemarkEdit(s, 40, 14, true)).join("\n");
    expect(lines).toContain("line 11");
    expect(boxDims(40, 14).rows).toBe(7);
  });

  test("remark column and detail stay within the width with CJK text", () => {
    const row = { name: "a", state: "ready" as const, phase: "start", remark: "今天修复登录问题，然后提交代码并等待评审结果\n第二行" };
    const out = strip(renderList({ setupId: "d", rows: [row], filter: line(""), sel: 0, msg: "", loaded: true }, 60, 14));
    for (const l of out) expect(visLen(l)).toBeLessThanOrEqual(60);
    expect(out.join("\n")).toContain("…");
    expect(remarkDetail("今天修复登录问题，然后提交代码并等待评审结果", 20).every((l) => visLen(l) <= 18)).toBe(true);
  });
});
