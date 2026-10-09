# 0008: Instance remark, a mutable free-form note shared by host and container

- **Status:** accepted (2026-10-09)
- **Context:** `container.annotations` are docker labels fixed at create time; `phase` is boot progress, written only from inside and reset per boot. We wanted one note that both sides can change at any time and that `ls` / the TUI show.
- **Decision:**
  - **A file, not a label**: `.wtc/run/<name>/remark` = `/wtc/run/remark` in the container (already bind-mounted, like `status.json`). One multi-line string, no length limit, empty file = none; not in `status.json`, not reset on restart.
  - **Single writer while running**: `wtc remark` goes through `docker exec … wtc-remark`; only a stopped instance is written by the host, in place. On colima (virtiofs) host-side writes were sometimes read back inside the container with a stale size, and rename / delete / recreate left a dead file (found by [integration.test.ts](../../examples/setup-basic/test/integration.test.ts)). Neither side renames or deletes it; clear = empty file.
  - **Display hardening**: the container can write it, so output goes through `plainRemark` (strips control characters). Tables show the first line (`…` if more); the TUI shows the selected row's full text under the list.
  - **TUI edit**: menu `r`; multi-line box ([tui/textarea.ts](../../packages/wtc/src/tui/textarea.ts), pure functions): Enter saves, Esc cancels, newline = Ctrl-J / Alt-Enter / Ctrl-Enter, readline-style keys, bracketed paste, Ctrl-G opens `$EDITOR` (else `vi`).
  - **No input library**: pi-tui's editor is tied to its framework, the others are single-line or own the screen. Text is handled as graphemes, words come from `Intl.Segmenter` (so Alt-B/F step over 今天|修复|登录), wrapping uses display width.
  - **Ctrl-Enter** is only reported by terminals with a key protocol (kitty, iTerm2, tmux `extended-keys`); the box asks for it while open. Terminal.app falls back to Ctrl-J / Alt-Enter.
  - `format.ts` is now display-width aware (`visLen` / `fit` / `clip`), which supersedes the "wide characters are not width-aware" note in [ADR 0004](0004-tui-and-host-scripts.md); ambiguous-width symbols stay narrow.
- **Entry points:** [ops/remark.ts](../../packages/wtc/src/ops/remark.ts), [kit/bin/wtc-remark](../../kit/bin/wtc-remark), [tui/remark.ts](../../packages/wtc/src/tui/remark.ts).
- **Consequences:** a container script can overwrite the user's note; if that hurts, add a second field rather than keys inside one string.
