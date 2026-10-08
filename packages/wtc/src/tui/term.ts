import { type Key, parseKeys } from "./keys";

/** What the app needs from a terminal; `createTerm` is the real one, tests use a fake. */
export interface Term {
  size(): { cols: number; rows: number };
  write(s: string): void;
  onKey(cb: (k: Key) => void): void;
  onResize(cb: () => void): void;
  /** Give the whole terminal back (leave the alt screen, cooked mode, stdin released) so a child can inherit it. */
  suspend(): void;
  resume(): void;
  /** Block until the user presses any key (used while suspended, to let command output be read). */
  waitKey(): Promise<void>;
  /** Restore the terminal for good. Idempotent. */
  close(): void;
}

const ENTER_ALT = "\x1b[?1049h\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l";

export function createTerm(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Term {
  let keyCb: ((k: Key) => void) | undefined;
  let resizeCb: (() => void) | undefined;
  let active = false;
  let closed = false;
  const onData = (chunk: string) => parseKeys(chunk).forEach((k) => keyCb?.(k));
  const onResize = () => resizeCb?.();
  const enter = () => {
    if (active || closed) return;
    active = true;
    stdout.write(ENTER_ALT);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  };
  const leave = () => {
    if (!active) return;
    active = false;
    stdin.off("data", onData);
    stdin.pause();
    stdin.setRawMode(false);
    stdout.write(LEAVE_ALT);
  };
  const close = () => {
    if (closed) return;
    leave();
    closed = true;
    stdout.off("resize", onResize);
    process.off("exit", close);
  };
  process.on("exit", close);
  stdout.on("resize", onResize);
  enter();
  return {
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    write: (s) => void stdout.write(s),
    onKey: (cb) => void (keyCb = cb),
    onResize: (cb) => void (resizeCb = cb),
    suspend: leave,
    resume: enter,
    waitKey: () =>
      new Promise((res) => {
        stdin.setEncoding("utf8");
        stdin.setRawMode(true); // any key, no Enter needed
        stdin.once("data", () => (stdin.setRawMode(false), stdin.pause(), res()));
        stdin.resume();
      }),
    close,
  };
}
