import { WtcError } from "../errors";
import { type CheckResult, type Health, runChecks } from "../health/health";
import type { InstanceContext } from "../instance/instance";
import { mustRun } from "./common";

/** Run a manifest script interactively in the instance; returns its exit code. */
export async function run(ctx: InstanceContext, name: string, script: string, args: string[]): Promise<number> {
  const m = ctx.setup.manifest;
  const sc = m.scripts[script];
  if (!sc) {
    const avail = Object.keys(m.scripts).join(", ") || "(none)";
    throw new WtcError("SCRIPT_NOT_FOUND", `no script "${script}"; available: ${avail}`);
  }
  const info = await mustRun(ctx, name);
  return ctx.rt.execInteractive(info.name, ["bash", "-lc", `${sc.run} "$@"`, script, ...args], { workdir: m.cwd });
}

/** Run manifest checks now. */
export async function check(ctx: InstanceContext, name: string): Promise<{ health: Health; items: CheckResult[] }> {
  const info = await mustRun(ctx, name);
  const m = ctx.setup.manifest;
  return runChecks(ctx.rt, info.name, m.checks, m.cwd);
}

/** Interactive login shell in the manifest cwd. */
export async function shell(ctx: InstanceContext, name: string): Promise<number> {
  const info = await mustRun(ctx, name);
  return ctx.rt.execInteractive(info.name, ["bash", "-l"], { workdir: ctx.setup.manifest.cwd, tty: true });
}
