#!/usr/bin/env node
// npm `bin` shim: the CLI needs bun (Bun.* APIs, runs wtc.setup.ts natively). Fail with a useful message when it is missing.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIN_BUN = [1, 3, 6]; // Bun.Archive; keep in sync with package.json "engines"
const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error("wtc requires bun (https://bun.sh), which was not found on PATH.\nInstall it, or use the prebuilt standalone binary (no bun needed): https://github.com/lyonbot/wtc/releases");
  process.exit(127);
}
const have = probe.stdout.trim().split(".").map(Number);
if (cmp(have, MIN_BUN) < 0) {
  console.error(`wtc requires bun >= ${MIN_BUN.join(".")} (found ${probe.stdout.trim()}). Run \`bun upgrade\`.`);
  process.exit(1);
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) - b[i];
  return 0;
}

const child = spawn("bun", [main, ...process.argv.slice(2)], { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
