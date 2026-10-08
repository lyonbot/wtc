export interface Key {
  /** "char" carries `ch`; otherwise a fixed name such as up, enter, esc, tab, backspace, ctrl-c */
  name: string;
  ch?: string;
}

const SEQ: Record<string, string> = {
  "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down", "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left",
  "\x1b[H": "home", "\x1b[1~": "home", "\x1b[F": "end", "\x1b[4~": "end", "\x1b[3~": "delete", "\x1b[Z": "shift-tab",
};
const CTRL: Record<string, string> = {
  "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x03": "ctrl-c", "\x01": "ctrl-a", "\x05": "ctrl-e",
  "\x13": "ctrl-s", "\x15": "ctrl-u", "\x17": "ctrl-w", "\x04": "ctrl-d",
};

/** Split a raw stdin chunk into keys. A lone ESC is `esc`; unknown escape sequences are dropped. */
export function parseKeys(s: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(s.slice(i));
      if (m) {
        const name = SEQ[m[0]];
        if (name) out.push({ name });
        i += m[0].length;
      } else {
        out.push({ name: "esc" });
        i++;
      }
      continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i)!);
    i += cp.length;
    const c = CTRL[cp];
    if (c) out.push({ name: c });
    else if (cp >= " ") out.push({ name: "char", ch: cp });
  }
  return out;
}

/** Single-line text input state: `cur` is a code-point index. */
export interface Line {
  text: string;
  cur: number;
}
export const line = (text = ""): Line => ({ text, cur: [...text].length });

/** Apply an editing key; returns null when `k` is not an editing key (caller handles it). */
export function editLine(l: Line, k: Key): Line | null {
  const cs = [...l.text];
  const mk = (a: string[], cur: number): Line => ({ text: a.join(""), cur });
  switch (k.name) {
    case "char": return mk([...cs.slice(0, l.cur), k.ch!, ...cs.slice(l.cur)], l.cur + 1);
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
  const cs = [...l.text];
  return cs.slice(0, l.cur).join("") + invert(cs[l.cur] ?? " ") + cs.slice(l.cur + 1).join("");
}
