import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { WtcError } from "../errors";
import { assertId } from "../naming";
import { SETUP_FILE } from "../setup/load";
import { WTC_VERSION } from "../version";

/** Slugify a directory name into a valid setup id (falls back to "app"). */
export const defaultSetupId = (dir: string) =>
  basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";

const files = (id: string): Record<string, string> => ({
  [SETUP_FILE]: `import { defineSetup } from "@lyonbot/wtc/setup";

/** Field reference: node_modules/@lyonbot/wtc/src/setup/schema.ts; guide: node_modules/@lyonbot/wtc/docs/authoring-setup.md */
export default defineSetup({
  id: ${JSON.stringify(id)},
  cwd: "/workspace/app",
  params: {
    // REPO: { description: "git url to clone", required: true },
  },
});
`,
  "image/Dockerfile": `FROM node:22-bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git openssh-client tmux curl ca-certificates util-linux \\
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@11.28.2
`,
  "init.sh": `#!/usr/bin/env bash
# Runs on every container boot: must be idempotent and must exit (0 = ready).
set -euo pipefail

wtc-signal phase clone
if [ ! -d /workspace/app ]; then
  mkdir -p /workspace
  # TODO: git clone "$REPO" /workspace/app   (declare REPO in params first)
  mkdir -p /workspace/app
fi

# wtc-signal phase install
# wtc-install -C /workspace/app

# wtc-signal phase start
# start long-running services detached (tmux), wait until healthy, then exit
`,
  "package.json": JSON.stringify(
    {
      name: `wtc-setup-${id}`,
      private: true,
      type: "module",
      devDependencies: { "@lyonbot/wtc": `^${WTC_VERSION}` },
      scripts: { up: "wtc up", ls: "wtc ls", shell: "wtc shell", doctor: "wtc doctor" },
    },
    null,
    2,
  ) + "\n",
  "tsconfig.json": JSON.stringify(
    { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true }, include: [SETUP_FILE] },
    null,
    2,
  ) + "\n",
  ".gitignore": ".wtc/\nnode_modules/\n",
});

/**
 * Scaffold a setup directory. Refuses to overwrite: fails before writing anything if any target file exists,
 * and removes what it wrote if a later write fails.
 */
export async function initSetup(o: { dir: string; id?: string }): Promise<{ dir: string; id: string; created: string[] }> {
  const dir = resolve(o.dir);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new WtcError("SETUP_EXISTS", `${dir} is not a directory`, "pass a new or existing directory");
  const id = o.id ?? defaultSetupId(dir);
  assertId("setupId", id);
  const out = files(id);
  const clash = Object.keys(out).filter((f) => existsSync(join(dir, f)));
  if (clash.length) throw new WtcError("SETUP_EXISTS", `already exists: ${clash.join(", ")}`, "use a dedicated setup dir (e.g. `wtc init wtc-setup`) or remove them first");
  const created: string[] = [];
  try {
    for (const [f, content] of Object.entries(out)) {
      await mkdir(dirname(join(dir, f)), { recursive: true });
      // "wx": never clobber a file that appeared after the clash check
      await writeFile(join(dir, f), content, { flag: "wx", ...(f === "init.sh" ? { mode: 0o755 } : {}) });
      created.push(f);
    }
  } catch (e) {
    await Promise.all(created.map((f) => rm(join(dir, f), { force: true })));
    throw e;
  }
  return { dir, id, created };
}
