# Development

- **Install:** `bun install`
- **Test:** `bun test` (integration tests only with `WTC_INTEGRATION=1`)
- **Typecheck:** `bun run typecheck`
- **Layout:** `packages/lib` (core logic, [src/index.ts](packages/lib/src/index.ts)), `packages/cli` (thin CLI, [src/main.ts](packages/cli/src/main.ts))
- **Design:** [docs/superpowers/specs/2026-09-30-wtc-design.md](docs/superpowers/specs/2026-09-30-wtc-design.md)
- **Kit:** container helper `wtc-kit` (Go, [kit/go](kit/go)) + scripts in [kit/bin](kit/bin); `bun run build:kit` ([kit/build.sh](kit/build.sh)) cross-compiles to `kit/dist/` (gitignored; `bun test` builds it if missing via [kit/test/preload.ts](kit/test/preload.ts)). Embedded/extracted by [packages/lib/src/kit/embed.ts](packages/lib/src/kit/embed.ts). Go tests: `cd kit/go && go test ./...`.
