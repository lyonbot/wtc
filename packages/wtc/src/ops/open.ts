import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceContext } from "../instance/instance";
import { mustExist } from "./common";

export interface OpenDeps {
  which: (bin: string) => string | null;
  spawn: (cmd: string[]) => void;
}
const defaultDeps: OpenDeps = {
  which: (b) => Bun.which(b),
  spawn: (cmd) => void Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref(),
};

/** Open the instance in VS Code / Cursor via attached-container URI. Editor: arg → config.json → `code`. */
export async function open(
  ctx: InstanceContext,
  name: string,
  editor?: "code" | "cursor",
  deps: OpenDeps = defaultDeps,
): Promise<{ uri: string; launched: boolean }> {
  const info = await mustExist(ctx, name);
  let ed: string = editor ?? "";
  if (!ed) {
    try {
      ed = JSON.parse(await readFile(join(ctx.home, ".config", "wtc", "config.json"), "utf8")).editor ?? "";
    } catch { /* no config */ }
  }
  ed ||= "code";
  const hex = Buffer.from(JSON.stringify({ containerName: "/" + info.name })).toString("hex");
  const uri = `vscode-remote://attached-container+${hex}${ctx.setup.manifest.cwd}`;
  if (!deps.which(ed)) return { uri, launched: false };
  deps.spawn([ed, "--folder-uri", uri]);
  return { uri, launched: true };
}
