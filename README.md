# wtc

One long-lived docker container per git worktree: same ports in every worktree, a shared pnpm store for fast installs, and a stable SOCKS5 address to reach each container's `127.0.0.1` services.

Requires: docker (Linux, or macOS with colima), [Bun](https://bun.sh) to build.

## Install

```sh
bun install
bun run build        # -> dist/wtc (single binary, embeds the container kit)
```

Put `dist/wtc` on your `PATH`.

## Quickstart

Uses the reference setup in [examples/setup-basic](examples/setup-basic) (on colima keep it under `$HOME`).

```sh
wtc --setup examples/setup-basic up feat-a   # builds image, blocks until ready/failed
wtc --setup examples/setup-basic tunnel feat-a
wtc --setup examples/setup-basic run feat-a restart-dev-server
wtc --setup examples/setup-basic rm feat-a
```

Setup resolution: `--setup <dir>`, then `WTC_SETUP`, then the nearest `wtc.setup.ts` above the cwd.

## Docs

- Write your own setup: [docs/authoring-setup.md](docs/authoring-setup.md)
- Use wtc from an AI agent: [packages/cli/skill/SKILL.md](packages/cli/skill/SKILL.md) (`wtc skill > .claude/skills/wtc/SKILL.md`)
- Contributing and tests: [DEVELOPMENT.md](DEVELOPMENT.md)
- Design: [docs/superpowers/specs/2026-09-30-wtc-design.md](docs/superpowers/specs/2026-09-30-wtc-design.md)
