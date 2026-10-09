/** Small ANSI/text helpers shared by the TUI views. Views return plain `string[]` lines; the app writes them. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const GRAPHEME = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Grapheme clusters of `s` (an emoji sequence or a letter with accents is one). */
export const graphemes = (s: string): string[] => Array.from(GRAPHEME.segment(s), (x) => x.segment);
/** Display width in terminal columns: CJK / emoji count two, combining marks zero, ANSI sequences zero. */
export const visLen = (s: string): number => Bun.stringWidth(s);

const wrap = (open: string) => (s: string) => `\x1b[${open}m${s}\x1b[0m`;
export const st = {
  bold: wrap("1"),
  dim: wrap("2"),
  inv: wrap("7"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

/** Truncate to `w` display columns (ANSI sequences count as zero width); resets styling when it cuts. A wide character that does not fit is dropped. */
export function fit(s: string, w: number): string {
  if (visLen(s) <= w) return s;
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; ) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const next = s.slice(i).search(/\x1b\[/);
    const run = next < 0 ? s.slice(i) : s.slice(i, i + next);
    for (const g of graphemes(run || s.slice(i, i + 1))) {
      const gw = visLen(g);
      if (n + gw > w) return out + "\x1b[0m";
      out += g;
      n += gw;
    }
    i += run.length || 1;
  }
  return out + "\x1b[0m";
}

/** Cut plain text to `n` display columns, ending in `…` when something was dropped. */
export function clip(s: string, n: number): string {
  if (visLen(s) <= n) return s;
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const gw = visLen(g);
    if (used + gw > n - 1) break;
    out += g;
    used += gw;
  }
  return n < 1 ? "" : out + "…";
}

export const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visLen(s)));

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1024) return `${n}B`;
  const units = ["K", "M", "G", "T"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) (v /= 1024), u++;
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)}${units[u]}`;
}

export const fmtCpu = (p: number | undefined): string => (p === undefined ? "-" : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);
