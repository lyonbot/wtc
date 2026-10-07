import type { InstanceSummary, UpEvent } from "../index";

export function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}

export function renderLs(list: InstanceSummary[]): string {
  if (!list.length) return "(no instances)";
  return table([
    ["NAME", "STATE", "PHASE", "SOCKS", "IMAGE"],
    ...list.map((s) => [s.name, s.state, s.phase ?? "-", s.socks ? `${s.socks.bind}:${s.socks.port}` : "-", s.staleImage ? "stale" : "current"]),
  ]);
}

export function renderSummary(s: InstanceSummary): string {
  const l = [`name:    ${s.name}`, `state:   ${s.state}`, `phase:   ${s.phase ?? "-"}`];
  if (s.health) l.push(`health:  ${s.health}`);
  if (s.message) l.push(`message: ${s.message}`);
  if (s.socks) l.push(`socks:   ${s.socks.urls.join(", ")}`);
  if (s.staleImage) l.push("image:   stale (run `wtc build`, then rm + up to recreate)");
  return l.join("\n");
}

/** Line-per-change renderer for `up`. Returns a function producing the lines for one event. */
export function upRenderer(name: string) {
  let lastPhase: string | null | undefined;
  return (e: UpEvent): string[] => {
    if (e.type === "action") return [`▸ ${e.action}${e.detail ? ` ${e.detail}` : ""}`];
    if (e.type === "status") {
      const p = e.summary.phase;
      if (p === lastPhase) return [];
      lastPhase = p;
      return p ? [`▸ phase ${p}`] : [];
    }
    const s = e.summary;
    if (s.state === "ready") return [`✔ ready${s.socks ? ` (socks ${s.socks.urls[0] ?? `${s.socks.bind}:${s.socks.port}`})` : ""}`];
    if (s.state === "failed") {
      const out = [`✖ failed${s.message ? ` (${s.message}${s.phase ? `, phase ${s.phase}` : ""})` : s.phase ? ` (phase ${s.phase})` : ""}`];
      if (e.logTail?.length) out.push(...e.logTail.map((l) => `  | ${l}`));
      out.push(`hint: wtc restart ${name}`);
      return out;
    }
    return [`▸ ${s.state}${s.phase ? ` (phase ${s.phase})` : ""}`];
  };
}
