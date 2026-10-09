import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { instancePaths } from "../instance/create-spec";
import type { InstanceContext } from "../instance/instance";
import { mustExist } from "./common";

/**
 * The remark is one free-form string in `.wtc/run/<name>/remark` (`/wtc/run/remark` in the container, written by kit/bin/wtc-remark).
 * Multi-line and unbounded on purpose; trailing newlines are dropped and an empty file means "no remark".
 */
export async function readRemark(file: string): Promise<string | undefined> {
  try {
    return dropTrailingNewlines(await readFile(file, "utf8")) || undefined;
  } catch {
    return undefined;
  }
}

export async function getRemark(ctx: InstanceContext, name: string): Promise<string | undefined> {
  await mustExist(ctx, name);
  return readRemark(instancePaths(ctx.setup.dir, name).remark);
}

/**
 * Replace the remark; "" clears it. Returns the stored value.
 * While the container runs, the write goes through the container's own `wtc-remark` (so the container is the only writer
 * it ever has to read back from): on colima a host-side write was sometimes read back with the old file size inside the
 * container, and a rename / delete / recreate left it with a dead file. The host reads the container's writes reliably.
 * A stopped container (or a failed / hung exec) falls back to writing the file in place from the host.
 */
export async function setRemark(ctx: InstanceContext, name: string, text: string): Promise<string | undefined> {
  const info = await mustExist(ctx, name);
  const file = instancePaths(ctx.setup.dir, name).remark;
  const value = dropTrailingNewlines(text);
  if (info.state === "running") {
    const input = value ? { input: new TextEncoder().encode(value) } : {};
    const r = await ctx.rt.exec(info.name, ["/wtc/bin/wtc-remark", ...(value ? ["-"] : ["--clear"])], { ...input, timeoutMs: 15_000 }).catch(() => null);
    if (r?.exitCode === 0) return value || undefined;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value);
  return value || undefined;
}

/** `s` without trailing CR / LF. A loop, not `/[\r\n]+$/`: that regex is quadratic on a long newline run (the file is container-writable). */
export function dropTrailingNewlines(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === "\n" || s[e - 1] === "\r")) e--;
  return s.slice(0, e);
}

/**
 * Make a remark safe for a terminal: it is writable from inside the container, so strip control characters (ANSI escapes
 * included). Newlines are kept; tabs become spaces.
 */
// eslint-disable-next-line no-control-regex
export const plainRemark = (s: string): string => s.replace(/\t/g, " ").replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");

/** First line for table cells; `…` marks that more follows. */
export function remarkHead(s: string | undefined): string {
  if (!s) return "-";
  const [first = "", ...rest] = plainRemark(s).split("\n");
  return rest.length ? `${first}…` : first;
}
