import { fit, graphemes, st, visLen } from "./format";
import type { Key } from "./keys";

/**
 * Multi-line text input as pure functions (state -> state), used by the remark box.
 * Text is handled as grapheme clusters (an emoji sequence or accented letter is one cursor step, one column group).
 * `cur` is a grapheme index; `goal` is the display column kept while moving up/down; `kill` is the last cut text (Ctrl-Y).
 */
export interface TextArea {
  text: string;
  cur: number;
  goal?: number;
  kill: string;
}
export const textarea = (text = ""): TextArea => ({ text, cur: graphemes(text).length, kill: "" });

/** One soft-wrapped screen row: graphemes [start, end) of the text; `eol` when a newline (or the end of text) follows. */
export interface Row {
  start: number;
  end: number;
  eol: boolean;
}

const cw = visLen;
const widthOf = (cs: string[], a: number, b: number): number => cs.slice(a, b).reduce((n, c) => n + cw(c), 0);

/** Soft-wrap to `width` display columns, preferring to break after a space (CJK text, having none, breaks at the width). */
export function layout(cs: string[], width: number): Row[] {
  const rows: Row[] = [];
  const w = Math.max(2, width);
  let ls = 0;
  for (;;) {
    let le = cs.indexOf("\n", ls);
    if (le < 0) le = cs.length;
    let s = ls;
    do {
      let i = s;
      let used = 0;
      let space = -1;
      while (i < le && (i === s || used + cw(cs[i]!) <= w)) {
        used += cw(cs[i]!);
        if (cs[i] === " ") space = i;
        i++;
      }
      const end = i < le && space > s ? space + 1 : i;
      rows.push({ start: s, end, eol: end === le });
      s = end;
    } while (s < le);
    if (le >= cs.length) return rows;
    ls = le + 1;
  }
}

/** Index of the row holding the cursor (a cursor on a wrap boundary belongs to the next row). */
export function cursorRow(rows: Row[], cur: number): number {
  const i = rows.findIndex((r) => cur < r.end || (cur === r.end && r.eol));
  return i < 0 ? rows.length - 1 : i;
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** Word-like runs as [start, end) grapheme indexes; uses ICU dictionaries, so 今天修复登录问题 is 今天 | 修复 | 登录 | 问题. */
function words(cs: string[]): [number, number][] {
  const at = new Map<number, number>(); // UTF-16 offset -> grapheme index
  let off = 0;
  cs.forEach((g, i) => (at.set(off, i), (off += g.length)));
  at.set(off, cs.length);
  return Array.from(WORDS.segment(cs.join("")))
    .filter((x) => x.isWordLike)
    .map((x) => [at.get(x.index)!, at.get(x.index + x.segment.length)!]);
}
const wordBack = (cs: string[], from: number): number => words(cs).filter(([a]) => a < from).pop()?.[0] ?? 0;
const wordFwd = (cs: string[], from: number): number => words(cs).find(([, b]) => b > from)?.[1] ?? cs.length;
const lineStart = (cs: string[], cur: number): number => cs.lastIndexOf("\n", cur - 1) + 1;
const lineEnd = (cs: string[], cur: number): number => {
  const i = cs.indexOf("\n", cur);
  return i < 0 ? cs.length : i;
};

/** Text that is safe to insert: newlines kept, tabs become spaces, other control characters dropped. */
export const cleanInput = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");

/**
 * Apply a key; `width` is the text width of the box (for up/down over wrapped rows). Returns null when the key is not an editing key
 * (Enter, Esc, Ctrl-G … belong to the caller).
 */
export function editTextArea(t: TextArea, k: Key, width: number): TextArea | null {
  const cs = graphemes(t.text);
  const set = (a: string[], cur: number, kill = t.kill): TextArea => ({ text: a.join(""), cur, kill });
  const cut = (from: number, to: number, keep = true): TextArea => set([...cs.slice(0, from), ...cs.slice(to)], from, keep ? cs.slice(from, to).join("") : t.kill);
  const ins = (s: string): TextArea => {
    const add = graphemes(cleanInput(s));
    const text = [...cs.slice(0, t.cur), ...add].join("");
    return { ...set([...cs.slice(0, t.cur), ...add, ...cs.slice(t.cur)], graphemes(text).length), goal: undefined }; // a combining mark may merge into the previous grapheme
  };
  const move = (cur: number): TextArea => ({ ...t, cur, goal: undefined });
  switch (k.name) {
    case "char": return ins(k.ch!);
    case "paste": return ins(k.ch ?? "");
    case "newline": return ins("\n");
    case "backspace": return t.cur ? cut(t.cur - 1, t.cur, false) : t;
    case "delete": case "ctrl-d": return t.cur < cs.length ? cut(t.cur, t.cur + 1, false) : t;
    case "left": case "ctrl-b": return move(Math.max(0, t.cur - 1));
    case "right": case "ctrl-f": return move(Math.min(cs.length, t.cur + 1));
    case "alt-left": case "ctrl-left": case "alt-b": return move(wordBack(cs, t.cur));
    case "alt-right": case "ctrl-right": case "alt-f": return move(wordFwd(cs, t.cur));
    case "home": case "ctrl-a": return move(lineStart(cs, t.cur));
    case "end": case "ctrl-e": return move(lineEnd(cs, t.cur));
    case "ctrl-home": return move(0);
    case "ctrl-end": return move(cs.length);
    case "ctrl-k": { // to the end of the line; at the end, joins the next line
      const e = lineEnd(cs, t.cur);
      return e === t.cur ? (t.cur < cs.length ? cut(t.cur, t.cur + 1) : t) : cut(t.cur, e);
    }
    case "ctrl-u": return t.cur === lineStart(cs, t.cur) ? t : cut(lineStart(cs, t.cur), t.cur);
    case "ctrl-w": case "alt-backspace": return cut(wordBack(cs, t.cur), t.cur);
    case "alt-d": case "ctrl-delete": case "alt-delete": return cut(t.cur, wordFwd(cs, t.cur));
    case "ctrl-y": return t.kill ? ins(t.kill) : t;
    case "up": case "down": {
      const rows = layout(cs, width);
      const r = cursorRow(rows, t.cur);
      const goal = t.goal ?? widthOf(cs, rows[r]!.start, t.cur);
      const to = r + (k.name === "up" ? -1 : 1);
      if (to < 0) return { ...t, cur: 0, goal: undefined };
      if (to >= rows.length) return { ...t, cur: cs.length, goal: undefined };
      const row = rows[to]!;
      const last = row.eol ? row.end : Math.max(row.start, row.end - 1); // a wrap boundary is the next row's start
      let c = row.start;
      while (c < last && widthOf(cs, row.start, c + 1) <= goal) c++;
      return { ...t, cur: c, goal };
    }
    default: return null;
  }
}

/** Keep the cursor row inside the `rows`-high window starting at `top`; returns the new `top`. */
export function scrollTop(t: TextArea, width: number, rows: number, top: number): number {
  const all = layout(graphemes(t.text), width);
  const r = cursorRow(all, t.cur);
  const max = Math.max(0, all.length - rows);
  return Math.min(max, r < top ? r : r >= top + rows ? r - rows + 1 : top);
}

/** The visible rows of the box (inverse-video cursor cell), each prefixed with `> ` / two spaces (so up to width + 3 columns), plus the total row count. */
export function renderTextArea(t: TextArea, width: number, rows: number, top: number): { lines: string[]; total: number } {
  const cs = graphemes(t.text);
  const all = layout(cs, width);
  const cr = cursorRow(all, t.cur);
  const from = Math.min(top, Math.max(0, all.length - rows));
  const lines = all.slice(from, from + rows).map((r, i) => {
    const idx = from + i;
    const body = cs.slice(r.start, r.end).join("");
    let text = body;
    if (idx === cr) {
      const at = t.cur - r.start;
      const chars = graphemes(body);
      text = chars.slice(0, at).join("") + st.inv(chars[at] ?? " ") + chars.slice(at + 1).join("");
    }
    return fit(`${idx === 0 ? st.cyan(">") : " "} ${text}`, width + 3); // + the cursor cell after a full row
  });
  return { lines, total: all.length };
}
