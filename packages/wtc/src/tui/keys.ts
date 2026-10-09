import { graphemes } from "./format";

export interface Key {
  /**
   * "char" carries `ch`; "paste" carries the pasted text in `ch`; otherwise a fixed name such as up, enter, esc, tab, backspace,
   * ctrl-c, alt-b, ctrl-left. "newline" is Ctrl-J or Shift/Alt/Ctrl-Enter (the last three need a terminal that reports them).
   */
  name: string;
  ch?: string;
}

const BASE: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<string, string> = { "1": "home", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };
const CTRL: Record<string, string> = { "\r": "enter", "\n": "newline", "\t": "tab", "\x7f": "backspace", "\b": "backspace" };
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Modifier prefix from an xterm/kitty modifier parameter (1 + shift 1 + alt 2 + ctrl 4). */
const modPrefix = (mod: number): string => {
  const m = mod - 1;
  return `${m & 4 ? "ctrl-" : ""}${m & 2 ? "alt-" : ""}${m & 1 ? "shift-" : ""}`;
};

/** A key reported by code point + modifiers (kitty `CSI code;mod u`, xterm modifyOtherKeys `CSI 27;mod;code ~`). */
function fromCode(code: number, mod: number): Key | null {
  const m = mod - 1;
  const mods = m & 7;
  if (code === 13) return { name: mods ? "newline" : "enter" };
  if (code === 9) return { name: m & 1 ? "shift-tab" : "tab" };
  if (code === 27 || (code === 91 && m & 4 && !(m & 3))) return { name: "esc" }; // Ctrl-[ is Esc, as the legacy byte
  if (code === 127 || code === 8) return { name: m & 6 ? "alt-backspace" : "backspace" };
  if (code < 32 || code >= 57344) return null; // functional / private-use keys are not used
  const ch = String.fromCodePoint(code);
  if (m & 4 && !(m & 3) && (code === 106 || code === 109)) return { name: code === 106 ? "newline" : "enter" }; // Ctrl-J / Ctrl-M, as the legacy bytes \n / \r
  if (m & 4) return /[a-z]/i.test(ch) ? { name: `ctrl-${ch.toLowerCase()}` } : null;
  if (m & 2) return { name: `alt-${ch.toLowerCase()}` };
  return { name: "char", ch: m & 1 ? ch.toUpperCase() : ch };
}

/**
 * Split a raw stdin chunk into keys. A lone ESC is `esc`; ESC + key is an Alt combination (`alt-b`, `alt-enter`);
 * bracketed paste becomes one "paste" key; unknown escape sequences are dropped.
 */
export function parseKeys(s: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "\x1b") {
      const cp = String.fromCodePoint(s.codePointAt(i)!);
      i += cp.length;
      const c = CTRL[cp];
      if (c) out.push({ name: c });
      else if (cp < " ") out.push({ name: `ctrl-${String.fromCharCode(cp.charCodeAt(0) + 96)}` }); // \x01 -> ctrl-a ...
      else if (cp !== "\x7f") out.push({ name: "char", ch: cp });
      continue;
    }
    if (s.startsWith(PASTE_START, i)) {
      const from = i + PASTE_START.length;
      const to = s.indexOf(PASTE_END, from);
      out.push({ name: "paste", ch: s.slice(from, to < 0 ? undefined : to) });
      i = to < 0 ? s.length : to + PASTE_END.length;
      continue;
    }
    const m = /^\x1b\[([0-9;:?]*)([A-Za-z~])/.exec(s.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      const [params = "", fin = ""] = [m[1], m[2]];
      const nums = params.split(";").map((x) => parseInt(x, 10));
      let k: Key | null = null;
      if (fin === "u") k = fromCode(nums[0] ?? 0, nums[1] || 1);
      else if (fin === "~" && nums[0] === 27) k = fromCode(nums[2] ?? 0, nums[1] || 1);
      else if (fin === "~") k = TILDE[String(nums[0])] ? { name: modPrefix(nums[1] || 1) + TILDE[String(nums[0])] } : null;
      else if (fin === "Z") k = { name: "shift-tab" };
      else if (BASE[fin]) k = { name: modPrefix(nums[1] || 1) + BASE[fin] };
      if (k) out.push(k);
      continue;
    }
    if (s[i + 1] === "O" && /[A-DHF]/.test(s[i + 2] ?? "")) {
      out.push({ name: BASE[s[i + 2]!]! });
      i += 3;
      continue;
    }
    const next = s[i + 1];
    // ESC + printable / Enter / Backspace is Alt; ESC + another control byte (Ctrl-C!) stays `esc` + that key
    if (next !== undefined && next !== "[" && next !== "O" && (next >= " " || "\r\n\x7f\b".includes(next))) {
      const cp = String.fromCodePoint(s.codePointAt(i + 1)!);
      i += 1 + cp.length;
      if (cp === "\r" || cp === "\n") out.push({ name: "newline" });
      else if (cp === "\x7f" || cp === "\b") out.push({ name: "alt-backspace" });
      else out.push({ name: `alt-${cp.toLowerCase()}` });
      continue;
    }
    out.push({ name: "esc" });
    i++;
  }
  return out;
}

/** Single-line text input state: `cur` is a grapheme index. */
export interface Line {
  text: string;
  cur: number;
}
export const line = (text = ""): Line => ({ text, cur: graphemes(text).length });

/** Apply an editing key; returns null when `k` is not an editing key (caller handles it). */
export function editLine(l: Line, k: Key): Line | null {
  const cs = graphemes(l.text);
  const mk = (a: string[], cur: number): Line => ({ text: a.join(""), cur });
  switch (k.name) {
    case "char": return mk([...cs.slice(0, l.cur), k.ch!, ...cs.slice(l.cur)], l.cur + 1);
    case "paste": {
      const ins = graphemes((k.ch ?? "").replace(/\s*[\r\n]+\s*/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
      return mk([...cs.slice(0, l.cur), ...ins, ...cs.slice(l.cur)], l.cur + ins.length);
    }
    case "backspace": return l.cur ? mk([...cs.slice(0, l.cur - 1), ...cs.slice(l.cur)], l.cur - 1) : l;
    case "delete": case "ctrl-d": return mk([...cs.slice(0, l.cur), ...cs.slice(l.cur + 1)], l.cur);
    case "left": return { ...l, cur: Math.max(0, l.cur - 1) };
    case "right": return { ...l, cur: Math.min(cs.length, l.cur + 1) };
    case "home": case "ctrl-a": return { ...l, cur: 0 };
    case "end": case "ctrl-e": return { ...l, cur: cs.length };
    case "ctrl-u": return mk(cs.slice(l.cur), 0);
    case "ctrl-w": {
      let i = l.cur;
      while (i > 0 && cs[i - 1] === " ") i--;
      while (i > 0 && cs[i - 1] !== " ") i--;
      return mk([...cs.slice(0, i), ...cs.slice(l.cur)], i);
    }
    default: return null;
  }
}

/** Render a Line with an inverse-video cursor cell. */
export function renderLine(l: Line, invert: (s: string) => string): string {
  const cs = graphemes(l.text);
  return cs.slice(0, l.cur).join("") + invert(cs[l.cur] ?? " ") + cs.slice(l.cur + 1).join("");
}
