# 0007: Bare `wtc` opens the TUI

- **Status:** accepted (2026-10-08)
- **Context:** Bare `wtc` only printed help, while the console ([ADR 0004](0004-tui-and-host-scripts.md)) is the natural entry point for humans.
- **Decision:**
  - No args (or only `--setup <dir>`, which just picks the setup), stdin and stdout both TTYs, a setup resolvable, and no opt-out: run `tui`. Rules and opt-out env list in [src/cli/interactive.ts](../../packages/wtc/src/cli/interactive.ts) (`defaultArgs`, `noInteractiveReason`), wired in [src/cli/main.ts](../../packages/wtc/src/cli/main.ts) (`withDefaultTui`).
  - Anything else keeps the old behaviour (help). No setup in a terminal adds a one-line `wtc init` hint on stderr.
  - Any other argument or flag, including `--help`, never opens the TUI.
  - Forwarding to a setup-local wtc ([ADR 0005](0005-forward-to-setup-local-wtc.md)) passes the empty argv through, so the local version decides (an older one prints help).
- **Consequences:** an agent harness that gives its shell a pty and sets none of the known markers would hang on bare `wtc`; `SKILL.md` tells agents never to run it, and `WTC_NO_TUI=1` covers the rest.
