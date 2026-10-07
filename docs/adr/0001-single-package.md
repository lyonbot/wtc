# 0001: Single package `@lyonbot/wtc`

- **Status:** accepted (2026-10-07)
- **Decision:** merge `packages/lib` + `packages/cli` into one package, [packages/wtc](../../packages/wtc), published as `@lyonbot/wtc`.
- **Why:** never published separately; one name for users (`npx @lyonbot/wtc`, one dependency for programmatic use and setup types); CLI was a thin wrapper.
- **Entry points** ([package.json](../../packages/wtc/package.json)):
  - `bin wtc` -> [src/cli/main.ts](../../packages/wtc/src/cli/main.ts) via shim [bin/wtc.js](../../packages/wtc/bin/wtc.js) (node; requires bun >= 1.3.6 for `Bun.Archive`, friendly error otherwise)
  - `.` -> [src/index.ts](../../packages/wtc/src/index.ts) (library API, no CLI side effects)
  - `./setup` -> [src/setup/index.ts](../../packages/wtc/src/setup/index.ts) (types + `defineSetup` for `wtc.setup.ts`)
- **Consequence:** layering (`src/cli` depends on the rest, never the reverse) is by convention, not by package boundary.
- Older docs under `docs/superpowers/` still say `@wtc/lib` / `@wtc/cli`; they are historical.
- **Open before publishing:** [kit/](../../kit) lives outside `packages/wtc` but is embedded by [src/kit/embed.ts](../../packages/wtc/src/kit/embed.ts); it must be copied into the package (`files`) at publish time. Prebuilt `bun build --compile` binary remains the no-bun option.
