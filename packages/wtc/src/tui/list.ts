import type { InstanceSummary } from "../instance/instance";
import { ID_RE } from "../naming";
import { fit, fmtBytes, fmtCpu, padEnd, st } from "./format";
import { renderLine, type Line } from "./keys";

export interface Row {
  name: string;
  state: InstanceSummary["state"];
  phase: string | null;
  message?: string;
  cpu?: number;
  mem?: number;
  staleImage?: boolean;
}
export type ListItem = { kind: "instance"; row: Row } | { kind: "create"; name: string };

/** Instances whose name contains the filter (case-insensitive), then the always-last create row; it carries the filter as the new name when that is a valid name. */
export function listItems(rows: Row[], filter: string): ListItem[] {
  const f = filter.trim().toLowerCase();
  const items: ListItem[] = rows.filter((r) => r.name.toLowerCase().includes(f)).map((row) => ({ kind: "instance", row }));
  return [...items, { kind: "create", name: ID_RE.test(f) ? f : "" }];
}

/** Where the selection goes after the filter changed: first match, or the create row when nothing matches. */
export const defaultSel = (items: ListItem[]): number => (items.length > 1 ? 0 : items.length - 1);

const stateStyle = (s: Row["state"]): ((t: string) => string) =>
  s === "ready" ? st.green : s === "failed" ? st.red : s === "booting" ? st.yellow : st.dim;

export interface ListView {
  setupId: string;
  rows: Row[];
  filter: Line;
  sel: number;
  msg: string;
  /** false until the first `ls` answered */
  loaded: boolean;
  /** a banner such as "docker unavailable" */
  banner?: string;
}

/** Full-screen lines for the list screen (`h` rows available, `w` columns). */
export function renderList(v: ListView, w: number, h: number): string[] {
  const items = listItems(v.rows, v.filter.text);
  const ready = v.rows.filter((r) => r.state === "ready").length;
  const out: string[] = [];
  out.push(`${st.bold(`wtc · ${v.setupId}`)}   ${v.loaded ? `${v.rows.length} instance${v.rows.length === 1 ? "" : "s"} · ${ready} ready` : st.dim("loading…")}`);
  out.push(v.banner ? st.red(v.banner) : "");
  out.push(`${st.cyan("filter")} ${renderLine(v.filter, st.inv)}`);
  const nameW = Math.max(4, ...v.rows.map((r) => r.name.length));
  const phaseW = Math.max(5, ...v.rows.map((r) => (r.phase ?? "-").length));
  out.push(st.dim(`  ${padEnd("NAME", nameW)}  ${padEnd("STATE", 8)}  ${padEnd("PHASE", phaseW)}  ${padEnd("CPU", 6)}  MEM`));
  const room = Math.max(1, h - out.length - 2);
  const top = Math.max(0, Math.min(v.sel - room + 1, items.length - room));
  items.slice(top, top + room).forEach((it, i) => {
    const on = top + i === v.sel;
    let text: string;
    if (it.kind === "create") text = `${on ? ">" : " "} ${it.name ? `+ create "${it.name}"` : "+ create…"}`;
    else {
      const r = it.row;
      const cell = (s: string, wd: number) => padEnd(s, wd);
      text = `${on ? ">" : " "} ${cell(r.name, nameW)}  ${stateStyle(r.state)(cell(r.state, 8))}  ${cell(r.phase ?? "-", phaseW)}  ${cell(fmtCpu(r.cpu), 6)}  ${fmtBytes(r.mem)}`;
    }
    out.push(on ? st.inv(padEnd(fit(text, w), w).replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")) : text);
  });
  while (out.length < h - 2) out.push("");
  out.push(v.msg ? st.yellow(v.msg) : "");
  out.push(st.dim("type to filter · ↑↓ select · Enter menu · Esc clear/quit · wtc --help: CLI"));
  return out.map((l) => fit(l, w));
}
