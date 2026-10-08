import type { Manifest } from "../setup/schema";
import { fit, st } from "./format";
import type { Row } from "./list";

export type MenuAction =
  | { type: "shell" }
  | { type: "open"; editor: "code" | "cursor" }
  | { type: "inspect" }
  | { type: "delete" }
  | { type: "script"; where: "container" | "host"; script: string };

export interface MenuItem {
  /** one-key shortcut */
  key: string;
  label: string;
  /** script description, rendered muted after the (bold) label */
  desc?: string;
  /** where a script runs; shown as a one-char marker (`$` host, `#` container) */
  tag?: "host" | "container";
  action: MenuAction;
}

const FIXED = { s: "shell", c: "open in Cursor", v: "open in VS Code", i: "inspect", d: "delete" } as const;
/** states in which the container is running, so shell / scripts can work */
const LIVE: Row["state"][] = ["ready", "booting", "failed"];

/** Menu for one instance: fixed items, then `scripts` (`#`) and `hostScripts` (`$`) with auto-assigned shortcuts. */
export function buildMenu(m: Pick<Manifest, "scripts" | "hostScripts">, row: Row): MenuItem[] {
  const live = LIVE.includes(row.state);
  const items: MenuItem[] = [];
  if (live) items.push({ key: "s", label: FIXED.s, action: { type: "shell" } });
  items.push({ key: "c", label: FIXED.c, action: { type: "open", editor: "cursor" } });
  items.push({ key: "v", label: FIXED.v, action: { type: "open", editor: "code" } });
  items.push({ key: "i", label: FIXED.i, action: { type: "inspect" } });
  items.push({ key: "d", label: FIXED.d, action: { type: "delete" } });
  const used = new Set(Object.keys(FIXED));
  const pick = (name: string): string => {
    const cands = [...name.toLowerCase().replace(/[^a-z0-9]/g, ""), ..."abcdefghijklmnopqrstuvwxyz0123456789"];
    const k = cands.find((c) => !used.has(c)) ?? "";
    used.add(k);
    return k;
  };
  const add = (where: "container" | "host", rec: Record<string, { description: string }>) => {
    for (const [script, s] of Object.entries(rec)) items.push({ key: pick(script), label: script, desc: s.description, tag: where, action: { type: "script", where, script } });
  };
  // host scripts talk to the running container (tunnel, ports), so they need a live one too
  if (live) {
    add("host", m.hostScripts);
    add("container", m.scripts);
  }
  return items;
}

/** One-char markers kept ASCII: ambiguous-width symbols can render double-width in CJK terminals and misalign the menu. */
export const TAG_MARK = { host: "$", container: "#" } as const;

export function renderMenu(name: string, items: MenuItem[], sel: number, w: number, h: number, msg = ""): string[] {
  const out = [st.bold(`${name}`), ""];
  items.forEach((it, i) => {
    const head = `${i === sel ? ">" : " "} [${it.key}] ${it.tag ? `${TAG_MARK[it.tag]} ` : ""}`;
    // the selected row is one inverse run (nested resets would cut it short); others get bold name + muted description
    out.push(i === sel ? st.inv(`${head}${it.label}${it.desc ? ` — ${it.desc}` : ""}`) : `${head}${it.desc ? st.bold(it.label) : it.label}${it.desc ? st.dim(` — ${it.desc}`) : ""}`);
  });
  while (out.length < h - 2) out.push("");
  out.push(msg ? st.yellow(msg) : "");
  out.push(st.dim("↑↓ + Enter or shortcut key · Esc back · $ runs on host · # runs in container"));
  return out.map((l) => fit(l, w));
}
