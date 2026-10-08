import { resolveSetupDir } from "../setup/load";

type Env = Record<string, string | undefined>;

/**
 * Why bare `wtc` must NOT open the TUI, or undefined when it may. A missing TTY on stdin or stdout, or any of the usual
 * "non-interactive" conventions: `WTC_NO_TUI`, `CI` (any non-empty value except 0/false/no/off), `NONINTERACTIVE` (Homebrew),
 * `DEBIAN_FRONTEND=noninteractive`, `TERM=dumb`, and agent harnesses that may hand their shell a pty
 * (`CLAUDECODE` - Claude Code, `CODEX_SANDBOX` - Codex CLI, `GEMINI_CLI` - Gemini CLI).
 */
export function noInteractiveReason(env: Env, tty: { stdin: boolean; stdout: boolean }): string | undefined {
  const on = (v: string | undefined) => !!v && !/^(0|false|no|off)$/i.test(v);
  if (!tty.stdin || !tty.stdout) return "not a terminal";
  if (on(env.WTC_NO_TUI)) return "WTC_NO_TUI is set";
  if (on(env.CI)) return "CI is set";
  if (on(env.NONINTERACTIVE)) return "NONINTERACTIVE is set";
  if (env.DEBIAN_FRONTEND === "noninteractive") return "DEBIAN_FRONTEND=noninteractive";
  if (env.TERM === "dumb") return "TERM=dumb";
  for (const k of ["CLAUDECODE", "CODEX_SANDBOX", "GEMINI_CLI"]) if (on(env[k])) return `running inside an agent (${k})`;
}

/**
 * Args for the default command: `[...args, "tui"]` when `args` is empty or only `--setup <dir>` / `--setup=<dir>`, the
 * session is interactive (see noInteractiveReason) and a setup resolves; otherwise `args` unchanged (commander prints help).
 * `hint` is set when only the missing setup kept the TUI closed. `args` excludes the runtime and script (process.argv.slice(2)).
 */
export function defaultArgs(args: string[], o: { env: Env; tty: { stdin: boolean; stdout: boolean }; cwd: string }): { args: string[]; hint?: string } {
  const flag = args.length === 0 ? undefined
    : args.length === 2 && args[0] === "--setup" ? args[1]
    : args.length === 1 && args[0]!.startsWith("--setup=") ? args[0]!.slice(8)
    : null;
  if (flag === null || noInteractiveReason(o.env, o.tty)) return { args };
  try {
    resolveSetupDir({ flag, env: o.env.WTC_SETUP, cwd: o.cwd });
  } catch {
    return { args, hint: "wtc: no wtc.setup.ts found here; run `wtc init` to create one" };
  }
  return { args: [...args, "tui"] };
}
