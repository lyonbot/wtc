import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultArgs, noInteractiveReason } from "../../src/cli/interactive";

// Every input is explicit: nothing here reads the developer's / CI's real env or TTYs.
const tty = { stdin: true, stdout: true };
const fixture = join(import.meta.dir, "../fixtures/basic");
const nowhere = "/"; // no wtc.setup.ts at the filesystem root

test("interactive only with two TTYs and no opt-out", () => {
  expect(noInteractiveReason({}, tty)).toBeUndefined();
  expect(noInteractiveReason({}, { stdin: false, stdout: true })).toContain("terminal");
  expect(noInteractiveReason({}, { stdin: true, stdout: false })).toContain("terminal");
});

test("conventional env opt-outs", () => {
  for (const env of [{ WTC_NO_TUI: "1" }, { CI: "true" }, { CI: "1" }, { NONINTERACTIVE: "1" }, { DEBIAN_FRONTEND: "noninteractive" }, { TERM: "dumb" },
    { CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }, { GEMINI_CLI: "1" }])
    expect(noInteractiveReason(env, tty)).toBeDefined();
  for (const env of [{ CI: "" }, { CI: "false" }, { CI: "0" }, { WTC_NO_TUI: "0" }, { CLAUDECODE: "" }, { TERM: "xterm-256color" }, { DEBIAN_FRONTEND: "dialog" }])
    expect(noInteractiveReason(env, tty)).toBeUndefined();
});

test("defaultArgs: bare or --setup-only opens tui when interactive and a setup resolves", () => {
  expect(defaultArgs([], { env: {}, tty, cwd: fixture })).toEqual({ args: ["tui"] });
  expect(defaultArgs([], { env: { WTC_SETUP: fixture }, tty, cwd: nowhere })).toEqual({ args: ["tui"] });
  expect(defaultArgs(["--setup", fixture], { env: {}, tty, cwd: nowhere })).toEqual({ args: ["--setup", fixture, "tui"] });
  expect(defaultArgs([`--setup=${fixture}`], { env: {}, tty, cwd: nowhere })).toEqual({ args: [`--setup=${fixture}`, "tui"] });
});

test("defaultArgs: anything else keeps the args (help)", () => {
  for (const args of [["--help"], ["-V"], ["ls"], ["--setup"], ["--setup", fixture, "ls"], ["--json"]])
    expect(defaultArgs(args, { env: {}, tty, cwd: fixture })).toEqual({ args });
  expect(defaultArgs([], { env: {}, tty: { stdin: true, stdout: false }, cwd: fixture })).toEqual({ args: [] });
  expect(defaultArgs([], { env: { CI: "1" }, tty, cwd: fixture })).toEqual({ args: [] });
});

test("defaultArgs: no setup in a terminal hints `wtc init`; non-interactive stays silent", () => {
  const r = defaultArgs([], { env: {}, tty, cwd: nowhere });
  expect(r.args).toEqual([]);
  expect(r.hint).toContain("wtc init");
  expect(defaultArgs([], { env: {}, tty: { stdin: false, stdout: false }, cwd: nowhere }).hint).toBeUndefined();
});
