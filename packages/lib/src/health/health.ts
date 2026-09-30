import type { Runtime } from "../runtime/types";
import type { Manifest } from "../setup/schema";

export type Health = "healthy" | "degraded" | "unhealthy" | "unknown";
export interface CheckResult { name: string; ok: boolean; exitCode: number; output: string; durationMs: number }

/** Run manifest checks inside the container (spec §8). Timeout => ok=false, exitCode 124. */
export async function runChecks(
  rt: Runtime,
  container: string,
  checks: Manifest["checks"],
  cwd: string,
): Promise<{ health: Health; items: CheckResult[] }> {
  const items = await Promise.all(
    Object.entries(checks).map(async ([name, ch]): Promise<CheckResult> => {
      const t0 = Date.now();
      const timeoutMs = ch.timeout * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
      try {
        const r = await Promise.race([
          rt.exec(container, ["bash", "-lc", ch.run], { workdir: cwd, timeoutMs }),
          timedOut,
        ]);
        if (r === "timeout") return { name, ok: false, exitCode: 124, output: `timed out after ${ch.timeout}s`, durationMs: Date.now() - t0 };
        return { name, ok: r.exitCode === 0, exitCode: r.exitCode, output: (r.stdout + r.stderr).trim(), durationMs: Date.now() - t0 };
      } catch (e) {
        return { name, ok: false, exitCode: 1, output: String((e as Error).message ?? e), durationMs: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const okN = items.filter((i) => i.ok).length;
  const health: Health = !items.length ? "unknown" : okN === items.length ? "healthy" : okN === 0 ? "unhealthy" : "degraded";
  return { health, items };
}
