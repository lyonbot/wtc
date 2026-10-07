# 0001: Single package `@lyonbot/wtc`

- **Status:** accepted (2026-10-07)
- **Decision:** merge `packages/lib` + `packages/cli` into one package, [packages/wtc](../../packages/wtc), published as `@lyonbot/wtc`.
- **Why:** never published separately; one name for users (`npx @lyonbot/wtc`, one dependency for programmatic use and setup types); CLI was a thin wrapper.
- **Entry points** ([package.json](../../packages/wtc/package.json)):
  - `bin wtc` -> [src/cli/main.ts](../../packages/wtc/src/cli/main.ts) (bun runtime required)
  - `.` -> [src/index.ts](../../packages/wtc/src/index.ts) (library API, no CLI side effects)
  - `./setup` -> [src/setup/index.ts](../../packages/wtc/src/setup/index.ts) (types + `defineSetup` for `wtc.setup.ts`)
- **Consequence:** layering (`src/cli` depends on the rest, never the reverse) is by convention, not by package boundary.
- Older docs under `docs/superpowers/` still say `@wtc/lib` / `@wtc/cli`; they are historical.
