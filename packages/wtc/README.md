# @lyonbot/wtc

Run one long-lived docker container per branch / worktree, so several copies of the same project can run side by side.

- **Requires [bun](https://bun.sh) >= 1.3.6** at runtime (`bin/wtc.js` checks and prints install help). The exports are TypeScript source for bun; Node/tsc consumers get types only.
- Install: `bun add -d @lyonbot/wtc` (types for `wtc.setup.ts`: `import { defineSetup } from "@lyonbot/wtc/setup"`).
- Overview, quickstart, security notes: <https://github.com/lyonbot/wtc#readme>
- Writing a setup: <https://github.com/lyonbot/wtc/blob/main/docs/authoring-setup.md>
