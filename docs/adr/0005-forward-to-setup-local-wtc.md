# 0005: Forward to the wtc installed beside the setup

- **Status:** accepted (2026-10-08)
- **Context:** A global `wtc` and the `@lyonbot/wtc` pinned in a setup's `node_modules` can differ. The manifest schema is strict and `wtc.setup.ts` runs against the running CLI's API, so a mismatched global CLI can reject or misread a setup.
- **Decision:**
  - Like a project-local `tsc`/`eslint`: after locating the setup dir (`--setup`, `$WTC_SETUP`, nearest `wtc.setup.ts`), if `<setup>/node_modules/@lyonbot/wtc` (or an ancestor's, for hoisted installs) has a **different version**, run its `bin/wtc.js` with the same argv/stdio and exit with its code.
  - Logic lives in [bin/forward.js](../../packages/wtc/bin/forward.js) (node-only, no deps); used by the npm shim [bin/wtc.js](../../packages/wtc/bin/wtc.js) before the bun probe, and by the compiled binary entry [src/cli/main.ts](../../packages/wtc/src/cli/main.ts).
  - Guards: `WTC_FORWARDED=1` is set on the child (no loops); `WTC_NO_FORWARD=1` disables. No setup found (`--help`, ...) means no forwarding. Notice goes to stderr only when it is a TTY, so `--json` output stays clean.
- **Consequences:**
  - A global wtc older than this feature cannot forward; only newer globals can.
  - The local install needs bun (its shim checks), even if the global one was the compiled binary.
