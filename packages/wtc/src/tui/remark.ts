import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropTrailingNewlines, plainRemark } from "../ops/remark";
import { fit, st } from "./format";
import type { Key } from "./keys";
import { editTextArea, renderTextArea, scrollTop, textarea, type TextArea } from "./textarea";

/** State of the "edit remark" screen: the text box and the first visible row. */
export interface RemarkEdit {
  name: string;
  ta: TextArea;
  top: number;
}

export const newRemarkEdit = (name: string, orig = ""): RemarkEdit => ({ name, ta: textarea(plainRemark(orig)), top: 0 });

/** Text width and visible rows of the box for a screen of `w` x `h`. */
export const boxDims = (w: number, h: number): { width: number; rows: number } => ({ width: Math.max(10, w - 3), rows: Math.max(3, h - 7) });

export type RemarkResult = { type: "none" } | { type: "cancel" } | { type: "save"; text: string } | { type: "editor" };

/** Key handling: Enter saves, Esc cancels, Ctrl-G asks for the external editor; everything else edits (see editTextArea). */
export function remarkKey(s: RemarkEdit, k: Key, dims: { width: number; rows: number }): [RemarkEdit, RemarkResult] {
  if (k.name === "esc") return [s, { type: "cancel" }];
  if (k.name === "ctrl-g") return [s, { type: "editor" }];
  if (k.name === "enter") return [s, { type: "save", text: s.ta.text }];
  const ta = editTextArea(s.ta, k, dims.width);
  if (!ta) return [s, { type: "none" }];
  return [{ ...s, ta, top: scrollTop(ta, dims.width, dims.rows, s.top) }, { type: "none" }];
}

export function renderRemarkEdit(s: RemarkEdit, w: number, h: number, editor: boolean): string[] {
  const { width, rows } = boxDims(w, h);
  const box = renderTextArea(s.ta, width, rows, scrollTop(s.ta, width, rows, s.top)); // re-fit: the window may have been resized
  const more = box.total > rows ? ` · ${box.total} rows` : "";
  const out = [st.bold(`remark · ${s.name}`) + st.dim(more), "", ...box.lines];
  while (out.length < h - 3) out.push("");
  out.push(st.dim("Enter save · Esc cancel · empty = clear · ↑↓ move · Ctrl-K/U/W/Y cut/paste · Alt-B/F word"));
  out.push(st.dim(`newline: Ctrl-J, Alt-Enter, Ctrl-Enter${editor ? " · Ctrl-G $EDITOR" : ""}`));
  return out.map((l) => fit(l, w));
}

/** `$EDITOR`, else `vi` when installed, else null (Ctrl-G then does nothing). */
export function resolveEditor(env: Record<string, string | undefined> = process.env, which: (c: string) => string | null = Bun.which): string | null {
  return env.EDITOR?.trim() || (which("vi") ? "vi" : null);
}

/** Edit `initial` in `editor` (a shell command line, may carry args) on the inherited terminal. `text` is the file afterwards, trailing newlines dropped. */
export async function runEditor(editor: string, initial: string): Promise<{ code: number; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wtc-remark-"));
  const file = join(dir, "remark.txt");
  try {
    await writeFile(file, initial + (initial ? "\n" : ""));
    const p = Bun.spawn(["sh", "-c", `${editor} "$1"`, "sh", file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await p.exited;
    return { code, text: dropTrailingNewlines(await readFile(file, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
