# 0004: `wtc tui` with an in-house ANSI renderer; `hostScripts` and `param.suggest` in the setup

- **Status:** accepted (2026-10-08)
- **Context:** Managing several instances meant remembering names, `--set` flags and per-setup helpers (open Chrome through the tunnel, pick a branch). We wanted one console that opens on the live instance list and can create, inspect and act on instances, for any setup.
- **Decision:**
  - **TUI over a web UI**: it fits the terminal workflow, needs no server, and ships in the same single binary. Shell access hands the whole terminal over (`w.shell` with inherited stdio) instead of embedding a terminal.
  - **No TUI dependency**: a small ANSI renderer ([src/tui/](../../packages/wtc/src/tui/app.ts)). Views are pure `state -> lines` functions ([list.ts](../../packages/wtc/src/tui/list.ts), [form.ts](../../packages/wtc/src/tui/form.ts), [menu.ts](../../packages/wtc/src/tui/menu.ts)), unit-tested without a terminal; `Term` ([term.ts](../../packages/wtc/src/tui/term.ts)) is the only code touching the tty. A library can replace the renderer later without touching the data layer.
  - **Setup-specific actions stay in the setup**: `hostScripts` (run on the host) next to `scripts` (run in the container), shown with one-char markers (`$` host, `#` container; ASCII on purpose, ambiguous-width symbols misalign in CJK terminals); `params.<K>.suggest` supplies form completions. wtc itself knows nothing about git or browsers.
  - **Live stats** come from a new `Runtime.stats` (`docker stats --no-stream`), polled together with `ls`; failures degrade to `-` or a banner, never crash.
- **Consequences:**
  - `hostScripts` and `suggest` are arbitrary host code from `wtc.setup.ts`, which was already trusted code (same as `hooks`).
  - Manifest schema is strict, so a setup using the new fields needs a wtc that knows them.
  - Wide (CJK / emoji) characters are not width-aware in the renderer; instance names are ASCII ids, messages may misalign.
