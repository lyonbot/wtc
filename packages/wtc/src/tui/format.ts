/** Small ANSI/text helpers shared by the TUI views. Views return plain `string[]` lines; the app writes them. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const visLen = (s: string): number => [...s.replace(ANSI, "")].length;

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

/** Truncate to `w` visible columns (ANSI sequences count as zero width); resets styling when it cuts. */
export function fit(s: string, w: number): string {
  if (visLen(s) <= w) return s;
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length && n < w; ) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i)!);
    out += cp;
    i += cp.length;
    n++;
  }
  return out + "\x1b[0m";
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
