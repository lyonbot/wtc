import { readFile } from "node:fs/promises";
import { WtcError } from "../errors";
import { instancePaths } from "../instance/create-spec";
import type { InstanceContext } from "../instance/instance";
import { mustExist } from "./common";

export type HostSpawn = (argv: string[], o: { cwd: string; env: Record<string, string> }) => Promise<number>;
const inheritSpawn: HostSpawn = async (argv, o) => await Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;

/** Params the instance was created with (`.wtc/run/<name>/config.json`); {} when the snapshot is missing. */
async function savedParams(ctx: InstanceContext, name: string): Promise<Record<string, string>> {
  try {
    return (JSON.parse(await readFile(instancePaths(ctx.setup.dir, name).config, "utf8")) as { params?: Record<string, string> }).params ?? {};
  } catch {
    return {};
  }
}

/** Run a manifest `hostScripts` entry on the host with inherited stdio; returns its exit code. */
export async function runHost(ctx: InstanceContext, name: string, script: string, args: string[], spawn: HostSpawn = inheritSpawn): Promise<number> {
  const m = ctx.setup.manifest;
  const hs = m.hostScripts[script];
  if (!hs) {
    const avail = Object.keys(m.hostScripts).join(", ") || "(none)";
    throw new WtcError("SCRIPT_NOT_FOUND", `no host script "${script}"; available: ${avail}`);
  }
  await mustExist(ctx, name);
  const env = {
    ...(process.env as Record<string, string>),
    ...(await savedParams(ctx, name)),
    WTC_NAME: name,
    WTC_SETUP_ID: m.id,
    WTC_SETUP_DIR: ctx.setup.dir,
  };
  return spawn(["bash", "-c", `${hs.run} "$@"`, script, name, ...args], { cwd: ctx.setup.dir, env });
}
