import { readFile } from "node:fs/promises";
import type { ContainerInfo } from "../runtime/types";

/** Shape of status.json, written by the container kit (kit/go/status.go). */
export interface StatusFile {
  bootId: string;
  startedAt: string;
  state: "booting" | "ready" | "failed";
  phase: string | null;
  message?: string;
  exitCode?: number;
  reason?: "exit" | "timeout";
  history: { at: string; state: string; phase?: string; message?: string }[];
}
export type InstanceState = "absent" | "stopped" | "booting" | "ready" | "failed";
export interface MergedState {
  state: InstanceState;
  phase: string | null;
  message?: string;
  exitCode?: number;
  reason?: string;
  bootId?: string;
  /** status.json predates the current container start (or is missing) */
  stale: boolean;
}

export async function readStatus(file: string): Promise<StatusFile | null> {
  try {
    const v = JSON.parse(await readFile(file, "utf8"));
    return v && typeof v === "object" ? (v as StatusFile) : null;
  } catch {
    return null;
  }
}

/** Parse ISO timestamps to epoch ms; docker's ns precision is truncated by Date.parse's ms resolution. */
const ms = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));

/** Combine runtime container state with status.json (spec §7 anti-stale rule, §8). */
export function mergeState(c: ContainerInfo | null, s: StatusFile | null): MergedState {
  if (!c) return { state: "absent", phase: null, stale: false };
  if (c.state !== "running" && c.state !== "restarting") return { state: "stopped", phase: null, stale: false };
  if (!s || ms(s.startedAt) < ms(c.startedAt)) return { state: "booting", phase: null, stale: true };
  const m: MergedState = { state: s.state, phase: s.phase ?? null, bootId: s.bootId, stale: false };
  if (s.message !== undefined) m.message = s.message;
  if (s.exitCode !== undefined) m.exitCode = s.exitCode;
  if (s.reason !== undefined) m.reason = s.reason;
  return m;
}

/** Polls `file`; yields the initial value, then again whenever the content changes. Ends on abort. */
export async function* watchStatus(
  file: string,
  o: { intervalMs?: number; signal?: AbortSignal } = {},
): AsyncIterable<StatusFile | null> {
  const interval = o.intervalMs ?? 250;
  let last: string | null | undefined;
  while (!o.signal?.aborted) {
    let raw: string | null = null;
    try { raw = await readFile(file, "utf8"); } catch { /* missing */ }
    if (raw !== last) {
      last = raw;
      let v: StatusFile | null = null;
      try { v = raw === null ? null : (JSON.parse(raw) as StatusFile); } catch { /* mid-write/invalid */ }
      yield v;
    }
    if (o.signal?.aborted) return;
    await new Promise<void>((res) => {
      const t = setTimeout(done, interval);
      function done() { clearTimeout(t); o.signal?.removeEventListener("abort", done); res(); }
      o.signal?.addEventListener("abort", done, { once: true });
    });
  }
}
