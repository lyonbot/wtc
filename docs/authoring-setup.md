# Authoring a wtc setup

A setup is a directory describing how to build and initialise one container per git worktree. Start from [examples/setup-basic](../examples/setup-basic); design rationale lives in [the spec](superpowers/specs/2026-09-30-wtc-design.md).

## Layout

- [wtc.setup.ts](../examples/setup-basic/wtc.setup.ts): `export default defineSetup({...})`; `defineSetup` is imported from `"@lyonbot/wtc/setup"` ([packages/wtc/src/setup/index.ts](../packages/wtc/src/setup/index.ts)). For editor types, put a `package.json` with `@lyonbot/wtc` as a devDependency in the setup dir (template: [package.json](../examples/setup-basic/package.json), [tsconfig.json](../examples/setup-basic/tsconfig.json); its `scripts` can call `wtc` directly); without it the CLI still resolves the import via a virtual module ([packages/wtc/src/cli/main.ts](../packages/wtc/src/cli/main.ts)).
- Manifest fields, defaults and validation: [packages/wtc/src/setup/schema.ts](../packages/wtc/src/setup/schema.ts) (the only field reference).
- [image/Dockerfile](../examples/setup-basic/image/Dockerfile): default build context. Editing `init.sh` / `scripts/` never rebuilds the image (they are mounted read-only at `/wtc/setup`).
- [init.sh](../examples/setup-basic/init.sh) and [scripts/](../examples/setup-basic/scripts/restart-dev-server.sh): container-side logic.
- `.wtc/` (gitignored): host-side run state and logs.
- Relative `bind` mount sources resolve against the setup dir; `~` expands to `$HOME`.

## init.sh contract

Runs on every container boot (including VM/colima restarts, `wtc restart`). Implementation: [kit/bin/wtc-entry](../kit/bin/wtc-entry).

- **Idempotent**: guard clone/copy steps (see the `[ ! -d ... ]` check in the example).
- **Must exit.** Exit code `0` = `ready`, non-zero = `failed`; exceeding `readyTimeout` also fails it. There is no separate ready signal.
- **Progress**: `wtc-signal phase <name> [msg]` ([kit/bin/wtc-signal](../kit/bin/wtc-signal)). Conventional names: `clone`, `install`, `start`.
- **Install**: `wtc-install [-C dir] [pnpm args]` ([kit/bin/wtc-install](../kit/bin/wtc-install)). Signals `install`, takes a shared lock on the pnpm store, runs `pnpm install --frozen-lockfile --prefer-offline`.
- **Long-running services** (dev servers): start detached in tmux, wait for them to be healthy, then exit. See [restart-dev-server.sh](../examples/setup-basic/scripts/restart-dev-server.sh).
- Output is teed to `.wtc/log/<name>/init.<bootId>.log` (`wtc logs`).
- A failed init leaves the container running for `wtc shell`; `wtc restart` reruns it.

```mermaid
flowchart LR
  A[wtc-entry] --> B[init.sh]
  B -->|exit 0| R[ready]
  B -->|exit != 0 / timeout| F[failed, container stays up]
```

## Image requirements

- Needed: bash, git, openssh-client, `flock` (util-linux), node >= 22, pnpm >= 11. Recommended: tmux, curl (for `checks`).
- For `wtc agent`: `tar` (needed), `npm` (auto-installs the agent; otherwise preinstall `claude` / `codex`), `ca-certificates` (needed by codex; `*-slim` bases lack it), `procps` (recommended: codex's shared app-server needs `ps`; without it wtc runs codex with `--no-daemon`). Root is fine.
- No socat/jq needed; port forwarding, SOCKS and status JSON come from `wtc-kit`.
- The image `ENTRYPOINT`/`CMD` are ignored; wtc overrides the entrypoint with `wtc-entry`.
- `wtc doctor` verifies the toolchain ([packages/wtc/src/ops/doctor.ts](../packages/wtc/src/ops/doctor.ts)).

## pnpm gotchas

- **`allowBuilds`**: pnpm 11 fails on ignored build scripts (`ERR_PNPM_IGNORED_BUILDS`). Declare `allowBuilds` in the repo's `pnpm-workspace.yaml` (example: [fixture-app/pnpm-workspace.yaml](../examples/setup-basic/fixture-app/pnpm-workspace.yaml)).
- **Missing `pnpm-lock.yaml`**: `wtc-install` uses `--frozen-lockfile`, which fails without a committed lockfile. Pass `wtc-install -C <repo> --no-frozen-lockfile`.
- **`shamefullyHoist: true` repos**: run commands via `pnpm run`, `pnpm exec` or `pnpx`. These rewrite `NODE_PATH` and related settings; plain `node x.js` may fail to resolve modules. Applies to `init.sh`, `scripts`, `checks` and tmux commands.
- **Files needed inside a cloned repo** (configs, env files): mount them to a side path and **copy** them in. Do not symlink; Node resolves `require` from the symlink's real path outside the repo.

## Optional: faster clones from a host checkout (reference only)

Not used by the example. An `init.sh` clone can borrow objects from an existing host clone instead of downloading them.

- **How**: `bind` the host repo read-only (e.g. `~/src/app` → `/mnt/src/app`), then `git -c safe.directory='*' clone --reference /mnt/src/app <url> <dir>`. Git fetches only objects the host lacks; `--reference` records them in `.git/objects/info/alternates`.
- **Measured**: repos with 50–65 MB packs on a fast intranet remote. Clone time dropped by about half (e.g. 8.7 s → 3.7 s for two repos). It stayed about as fast with a host clone two months behind. The rest of the time is mostly worktree checkout.
- **Not worth it**: `--dissociate`, which copies the borrowed objects and was slower than a plain network clone. A plain local clone of the mount (`git clone /mnt/src/app`) was a smaller gain and gives a bigger `.git`.
- **Caveats**:
  - The container repo depends on the mount for its whole life. Keep it a permanent setup `bind`, at the same path.
  - `git gc --prune` on the host can delete objects the container still uses (`fatal: bad object`); the fix is re-cloning. A read-only mount protects the host, not the container.
  - `safe.directory` is needed: the host repo is owned by a different uid than the container user.
  - On colima the host repo must be under `$HOME` (see below).

## Host / platform notes

- **colima shares only `$HOME`**: the setup dir and every `bind` source must live under it (else `BIND_NOT_SHARED`); `/tmp` and `/private/tmp` mount as empty dirs.
- **Private git over ssh**: private keys never enter the container; the host ssh-agent is forwarded to `/wtc/ssh-agent.sock`.
  - colima needs `forwardAgent: true` in `~/.colima/default/colima.yaml` (`wtc doctor` checks it).
  - List git hosts in `ssh.knownHosts`; entries are copied from the host's `~/.ssh/known_hosts`. A missing entry is a warning and the host is skipped: `ssh` to it once on the host first.
  - Alternative without an agent: `bind` a key file read-only to a side path, copy it to `~/.ssh` with mode 600 in `init.sh`, and set `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes"`.
- **Params** are injected as plain env vars: do not put secrets there.
- **`hostForwards`**: container `127.0.0.1:<p>` reaches host `<p>`. On Linux the host service must listen on docker0 or `0.0.0.0`.

## Coding agents (`wtc agent`)

`wtc agent <name> <claude|codex> [-- args]` runs the agent in the instance `cwd`. Flow: [packages/wtc/src/ops/agent.ts](../packages/wtc/src/ops/agent.ts); what gets synced: [packages/wtc/src/agent/](../packages/wtc/src/agent); design: [the agent spec](superpowers/specs/2026-10-01-wtc-agent-design.md).

```mermaid
flowchart LR
  H["host: Keychain / ~/.claude, ~/.claude.json<br/>~/.codex, ~/.agents/skills"] -- "filter + rewrite paths<br/>(in-memory tar)" --> C["container $HOME"]
  C --> A["claude / codex<br/>(auto npm install if missing)"]
```

- **Every launch** re-syncs the host login plus user-level config: Claude credentials (macOS Keychain first), user MCP servers, `settings.json` (minus `hooks` / `statusLine` / helper commands), `CLAUDE.md`, skills, plugins (without `.git`); Codex `auth.json`, a filtered `config.toml`, `AGENTS.md`, skills. Container-side history is kept.
- **Permissions**: the container is the sandbox. claude gets `--dangerously-skip-permissions` (+ `IS_SANDBOX=1` for root), codex `--dangerously-bypass-approvals-and-sandbox` (bubblewrap cannot run in an unprivileged container). Built-ins also disable auto-update / telemetry (`AGENTS` in [ops/agent.ts](../packages/wtc/src/ops/agent.ts); codex's go into the synced `config.toml`, since any `-c` forces codex into embedded mode). First-run dialogs (onboarding, folder trust, bypass / auto-mode prompts) are pre-answered.
- **Manifest `agents.<claude|codex>`**: `env` (literal, `{ fromHost: "VAR" }`, or `null` to drop a built-in), `args` (before CLI args), `version` (auto-install version). Applied per launch; never recreates the container.
- **Token refresh**: the container gets a copy of the host tokens and nothing is written back. If a long container session refreshes them, the host (or another container) may be logged out. For many concurrent containers prefer `claude setup-token` + `agents.claude.env.CLAUDE_CODE_OAUTH_TOKEN: { fromHost: "…" }` for Claude and an API key for Codex.
- **Security**: code running in the container can read the synced credentials. Use only with trusted repositories.
- **MCP OAuth logins** travel only when they live in files:

  | Where the host keeps the token | Synced |
  |---|---|
  | Claude native OAuth (`mcpOAuth` inside the Claude credentials) | yes |
  | `mcp-remote` cache `~/.mcp-auth` (either agent) | yes |
  | Codex native OAuth, file store `~/.codex/.credentials.json` (Linux without a keyring) | yes |
  | Codex native OAuth in macOS Keychain / Linux secret service | no: wtc never reads these (Keychain prompts). Proxy that server through `mcp-remote` (`command = "npx"`, `args = ["-y", "mcp-remote@latest", "<url>"]`) or set `mcp_oauth_credentials_store = "file"` and log in again |

- **Keychain (macOS)**: only the `Claude Code-credentials` item is read. If macOS asks, choose *Always Allow*. A `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in `agents.claude.env` skips the read entirely. Linux hosts read `~/.claude/.credentials.json` directly.
- **Limits**: plugin / marketplace updates only work on the host (no `.git` in the container); stdio MCP servers need their runtime in the image; MCP servers pointing at host-only paths (home dir, `/Applications`, `.app` bundles, `/snap`, `/nix`, …) are dropped.

## SOCKS exposure

- `socksBind` defaults to `0.0.0.0`: **anyone on the LAN** can reach every `127.0.0.1` service in the container and, through it, the host (`host.docker.internal`) and the container's networks.
- Restrict with `socksBind: "127.0.0.1"` or require credentials with `socksAuth: { user, pass }` (plain text in the manifest; also passed as env to the container).
- Both are creation-time settings: change requires `wtc rm` and `up`.
- The tunnel address is **dynamic by design**: the port is picked from `socksHostPortRange` at creation and may differ after `rm` + `up`. Clients get the current one from `wtc tunnel`. Pin it with `socksHostPort` only if something truly needs a fixed port.
- Clients must use `socks5h://` and drop `localhost` from `NO_PROXY` (`wtc tunnel` prints hints).
- On macOS the firewall must allow `limactl` for LAN access.

## See also

- Agent usage of the CLI: [packages/wtc/skill/SKILL.md](../packages/wtc/skill/SKILL.md)
- Running the example end to end: [README.md](../README.md), [DEVELOPMENT.md](../DEVELOPMENT.md)
