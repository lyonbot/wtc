import { createServer } from "node:net";
import { WtcError } from "../errors";
import { LABEL } from "../naming";
import type { Runtime } from "../runtime/types";

function canListen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen({ port, host: "0.0.0.0", exclusive: true }, () => s.close(() => res(true)));
  });
}

/**
 * First port in `range` not claimed by any wtc container label (across setups), not in `exclude`,
 * and currently bindable on 0.0.0.0 (spec §10).
 */
export async function allocateSocksPort(rt: Runtime, range: [number, number], exclude: Set<number>): Promise<number> {
  const used = new Set(exclude);
  for (const c of await rt.ps({})) {
    const p = Number(c.labels[LABEL.socksHostPort]);
    if (p) used.add(p);
  }
  for (let p = range[0]; p <= range[1]; p++) {
    if (used.has(p)) continue;
    if (await canListen(p)) return p;
  }
  throw new WtcError("NO_FREE_PORT", `no free socks host port in ${range[0]}-${range[1]}`, "free a port, widen socksHostPortRange, or pass --socks-host-port");
}
