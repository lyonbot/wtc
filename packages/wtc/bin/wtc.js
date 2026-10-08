#!/usr/bin/env node
// npm `bin` shim: the CLI needs bun (Bun.* APIs, runs wtc.setup.ts natively). Fail with a useful message when it is missing.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findLocalWtc, runForwarded } from "./forward.js";

const MIN_BUN = [1, 3, 6]; // Bun.Archive; keep in sync with package.json "engines"
const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

// A wtc installed beside the setup wins over this (e.g. global) one when versions differ.
const selfVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const local = findLocalWtc({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), selfVersion });
if (local) {
  if (process.stderr.isTTY) console.error(`wtc: using the setup's local v${local.version} (this one is v${selfVersion})`);
  const code = await runForwarded("node", local.entry, process.argv.slice(2), process.env);
  if (code !== undefined) process.exit(code);
}

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
