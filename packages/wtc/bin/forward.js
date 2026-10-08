// Dispatch to the wtc installed next to the user's setup (like a project-local tsc/eslint). Plain node-only JS: used by bin/wtc.js (before bun is even probed) and by the compiled binary's entry (src/cli/main.ts).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SETUP_FILE = "wtc.setup.ts";
const LOCAL_REL = join("node_modules", "@lyonbot", "wtc");

/** `--setup <dir>` / `--setup=<dir>` from raw argv (commander is not up yet). Stops at `--`. */
function setupFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "--setup") return argv[i + 1];
    if (argv[i].startsWith("--setup=")) return argv[i].slice(8);
  }
}

/** First positional of raw argv (the subcommand), skipping `--setup <dir>`. */
function subcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--setup") i++;
    else if (!argv[i].startsWith("-")) return argv[i];
  }
}

/** Same precedence as resolveSetupDir (src/setup/load.ts); returns undefined instead of throwing. */
function locateSetupDir(argv, env, cwd) {
  const explicit = setupFlag(argv) || env.WTC_SETUP;
  if (explicit) return resolve(cwd, explicit);
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, SETUP_FILE))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Entry of a different wtc version installed in (or above) the setup dir, or undefined to run the current one.
 * @param {{argv: string[], env: Record<string, string | undefined>, cwd: string, selfVersion: string}} o argv excludes node/script
 */
export function findLocalWtc({ argv, env, cwd, selfVersion }) {
  if (env.WTC_NO_FORWARD || env.WTC_FORWARDED) return undefined;
  // `init` creates a setup: the cwd's enclosing setup (and its possibly older wtc, maybe without `init`) is unrelated
  if (subcommand(argv) === "init") return undefined;
  const setupDir = locateSetupDir(argv, env, cwd);
  if (!setupDir) return undefined;
  for (let d = setupDir; ; d = dirname(d)) {
    const pkgDir = join(d, LOCAL_REL);
    try {
      const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
      const entry = realpathSync(join(pkgDir, "bin", "wtc.js"));
      return version === selfVersion ? undefined : { entry, version };
    } catch {}
    if (dirname(d) === d) return undefined;
  }
}

/** Run `entry` with stdio inherited; resolves to its exit code (signals re-raised on this process). */
export function runForwarded(runner, entry, argv, env) {
  return new Promise((done) => {
    const child = spawn(runner, [entry, ...argv], { stdio: "inherit", env: { ...env, WTC_FORWARDED: "1" } });
    for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
    child.on("error", () => done(undefined));
    child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : done(code ?? 1)));
  });
}
