---
name: wtc
description: Run an isolated docker dev container per git worktree with the `wtc` CLI. Use when you need a sandboxed environment for a branch/worktree, to start, stop, restart or remove such containers, to reach a dev server on the container's 127.0.0.1 through a SOCKS5 proxy, to run scripts or health checks inside it, to debug a container that failed to boot, or when the project has a wtc.setup.ts.
---

# wtc

One docker container per worktree/instance, defined by a `wtc.setup.ts` in the project. Each instance gets a host SOCKS5 port so the host can reach the container's `127.0.0.1` services. The tunnel address (IP:port) is dynamic: call `wtc tunnel` each time you need it; never cache or hardcode it.

## When to use

- Project contains `wtc.setup.ts` (or user mentions wtc / per-worktree containers).
- You need an isolated env per branch, or to reach a dev server inside a container.
- Do not use for one-off `docker run`; do not edit `wtc.setup.ts` unless asked. It may `import { defineSetup } from "@lyonbot/wtc/setup"` or just `export default { ... }`.

## Quick reference

Global: `--setup <dir>` or env `WTC_SETUP` (default: search upwards from cwd for `wtc.setup.ts`). Query commands accept `--json`.

- `wtc build` - build image; skipped if unchanged.
- `wtc up <name> [--set K=V]... [--socks-bind <addr>] [--socks-host-port <p>] [--no-wait]` - absent: create; stopped: start; booting: wait; ready: return. Exit 1 if final state is failed. Re-run `wtc up <name>` at any time to resume waiting (e.g. after Ctrl-C or `--no-wait`). `--set`/socks flags are creation-time only.
- `wtc start <name>` / `wtc stop <name>` - stop keeps the overlay filesystem.
- `wtc restart <name>` - re-run init.sh (use after a failed boot).
- `wtc rm <name> [--force]` - runs `preRemove`, then deletes container, instance volumes, state.
- `wtc ls [--json]` - NAME STATE PHASE SOCKS IMAGE.
- `wtc status <name> [--watch] [--json]` - state, phase, health, socks, `staleImage`.
- `wtc logs <name> [-f] [--boot <id>]` - init logs.
- `wtc run <name> <script> [-- args]` - manifest script in the container; exits with its exit code.
- `wtc check <name> [--json]` - run health checks now.
- `wtc shell <name>` - interactive shell (needs a TTY; exits with the shell's code).
- `wtc agent <name> <agent> [-- args]` - run Claude Code (`claude`), Codex (`codex`) or a custom agent defined under manifest `agents` in the container's `cwd` with the host login, user MCP servers, skills and plugins synced in; auto-installs the agent via npm when missing; runs with permission prompts / inner sandbox disabled (the container is the sandbox); exits with the agent's code. Extra env/args come from manifest `agents.<agent>`.
- `wtc tunnel <name> [--json]` - print `socks5h://` URLs and hints. The address may change between calls (e.g. after `rm` + `up`); re-run it rather than reusing an old one.
- `wtc open <name> [code|cursor]` - open in editor via attached-container URI.
- `wtc tui` - interactive console for humans (needs a TTY; not for agents): live instance list with state / CPU / memory, create form, action menu (shell, editor, `scripts`, `hostScripts`).
- `wtc gc [--dry-run] [--prune-store]` - remove orphaned state.
- `wtc doctor [--json]` - check runtime, colima mounts, firewall, toolchain.
- `wtc skill [--llms]` - print this guide.

States: `absent` `stopped` `booting` `ready` `failed`. Names match `^[a-z0-9]+(-[a-z0-9]+)*$`.

## Typical flows

**Create and wait**
1. `wtc up feat-x --set BRANCH=feat/x` - blocks until `ready` or `failed`.
2. `wtc status feat-x --json` to confirm.

**Reach a dev server inside the container**
1. `wtc tunnel feat-x` -> `socks5h://127.0.0.1:<port>`.
2. `curl --socks5-hostname 127.0.0.1:<port> http://127.0.0.1:5173/`.
3. Always `socks5h` (DNS in container). Unset `NO_PROXY`/`no_proxy` entries for `localhost`/`127.0.0.1` for that client, otherwise it bypasses the proxy and hits the host's own port.

**Run a script**: `wtc run feat-x test -- --watch=false`; the exit code is the script's.

**Delegate to an agent inside the container**: `wtc agent feat-x claude -- -p "run the tests and fix failures"` (or `wtc agent feat-x codex -- exec "…"`). Put agent flags after `--`.

**Debug a failed boot**
1. `wtc status feat-x` (phase + message).
2. `wtc logs feat-x` (last boot's init log).
3. `wtc shell feat-x` to inspect.
4. Fix, then `wtc restart feat-x`. init.sh must be idempotent.

**Cleanup**: `wtc rm feat-x` (add `--force` if stopped/failed or preRemove blocks), then `wtc gc`.

## JSON output

- `--json` prints the library value: `ls` -> array, `status` -> object with `name, container, state, phase, message?, health?, socks?{bind,port,urls}, staleImage, bootId?`.
- `up --json` prints newline-delimited events: `{"type":"action"|"status"|"done", ...}`; `done` carries `summary` and, on failure, `logTail`.
- `check --json` -> `{health, items[{name, ok, exitCode, output, durationMs}]}`; `tunnel --json` -> `{urls, bind, port, auth, hints}`.

## Errors & fixes

Errors print `error: <message>` and `hint: <hint>` on stderr, exit 1 (usage errors exit 2).

| Code | Meaning | Fix |
|---|---|---|
| `SETUP_NOT_FOUND` | no `wtc.setup.ts` | pass `--setup <dir>` or set `WTC_SETUP` |
| `SETUP_ID_CONFLICT` | another setup dir already uses this setup `id` | change `id` in `wtc.setup.ts` or `rm` the other setup's instances |
| `INVALID_MANIFEST` | manifest fails validation / bind source missing | fix `wtc.setup.ts`; check the message paths |
| `BIND_NOT_SHARED` | bind source not under a runtime-shared dir (colima: under `$HOME`) | move the source under `$HOME` |
| `RUNTIME_UNAVAILABLE` | docker daemon unreachable | start docker/colima; run `wtc doctor` |
| `RUNTIME_ERROR` | docker command failed | read the message; run `wtc doctor` |
| `NOT_FOUND` | instance does not exist | `wtc ls`; `wtc up <name>` |
| `NOT_RUNNING` | instance is not running | `wtc start <name>` or `wtc up <name>` |
| `SCRIPT_NOT_FOUND` | script not in manifest `scripts` | check `wtc.setup.ts` |
| `INVALID_ID` | bad instance/setup id | lowercase letters, digits, single hyphens (e.g. `feat-a`) |
| `PARAM_INVALID` | `--set` value fails the param's pattern | pass a matching value |
| `PARAMS_MISMATCH` | explicit `--set`/create-time value differs from how the instance was created | `wtc rm <name>` then `wtc up` with the new value |
| `PARAM_REQUIRED` | required param missing | pass `--set K=V` |
| `PARAM_UNKNOWN` | param not declared in manifest | remove it or declare it |
| `PORT_IN_USE` | socks host port taken (existing instance) | free the port, or `wtc rm` and re-`up` |
| `NO_FREE_PORT` | no free port in `socksHostPortRange` | free ports or pass `--socks-host-port` |
| `PREREMOVE_REJECTED` | `preRemove` exited non-zero (e.g. unpushed work) | resolve the issue, or `rm --force` (loses work) |
| `HOOK_FAILED` | `hooks.preBoot` or a function-valued `container` in `wtc.setup.ts` threw | fix the hook, or catch inside it to make it best-effort |
| `RM_NEEDS_RUNNING` | `preRemove` needs a running container | `wtc start <name>` then `rm`, or `rm --force` |
| `AGENT_NO_CREDENTIALS` | the host has no Claude / Codex login | log in on the host (`claude`, `codex login`) |
| `AGENT_UNKNOWN` | the agent name is not defined in manifest `agents` | use `claude`, `codex` or a name the message lists |
| `AGENT_ENV_MISSING` | an `agents.<agent>.env` `fromHost` variable is unset on the host | export it on the host |
| `AGENT_INSTALL_FAILED` | auto-install failed, the agent and npm are both missing, or a custom agent has no `pkg` | check container network; preinstall the agent in the image |
| `AGENT_IMAGE_UNSUPPORTED` | the image lacks bash / tar | add them to the image |
| `AGENT_SYNC_FAILED` | copying the agent config into the container failed | read the message; check disk space / `$HOME` permissions |

An instance in `failed` state keeps its container: debug (see flow above), then `wtc restart`.

## Safety

- `wtc rm` runs the manifest `preRemove` (e.g. unpushed-work check) and refuses on non-zero. `--force` skips it and deletes instance volumes: unpushed work is lost. Never use `--force` without the user's consent.
- SOCKS has no auth unless the manifest sets `socksAuth`. With the default bind `0.0.0.0`, anyone on the LAN can use it to reach the container's `127.0.0.1`, the host (`host.docker.internal`) and any network the container reaches. Prefer `--socks-bind 127.0.0.1` on untrusted networks; the bind is fixed at creation (`rm` + `up` to change).
- `wtc agent` copies the host's agent credentials into the container and skips permission prompts: code in the container can read them. Use only with trusted repositories.
- Image changes show as `staleImage: true` (`IMAGE` column `stale`); wtc never rebuilds instances automatically.
