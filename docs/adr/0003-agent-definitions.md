# 0003: Agents are definitions with hooks, not a fixed kind enum

- **Status:** accepted (2026-10-06)
- **Context:** `wtc agent` supported only `claude` and `codex`, hard-coded as a kind enum in the schema, the op and the CLI. Teams run variants (`claude-custom`, `codex-custom`, …) that install and sync the same way but differ in env, and often in the host config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Other CLIs need their own file sync and setup commands.
- **Decision:**
  - The manifest `agents` is a record of `AgentDefinition` ([packages/lib/src/agent/define.ts](../../packages/lib/src/agent/define.ts)): `bin`, `pkg`, `version`, `env`, `args`, `probe`, plus async `sync` / `afterSync` hooks that get an `AgentContext` (host file helpers, container `exec`, editable env).
  - The built-ins are ordinary definitions: `defineClaudeAgent` / `defineCodexAgent` ([agent/claude.ts](../../packages/lib/src/agent/claude.ts), [agent/codex.ts](../../packages/lib/src/agent/codex.ts)); variants layer options on them via `extendAgent`, including `configDir`.
  - [ops/agent.ts](../../packages/lib/src/ops/agent.ts) is a generic runner (probe, sync, install, extract, afterSync, launch) with no per-agent branches. The CLI passes any name through; unknown names fail with `AGENT_UNKNOWN`.
  - One syntax: every `agents` entry must come from `defineAgent` / `defineClaudeAgent` / `defineCodexAgent` (branded with a symbol); the earlier `agents.claude: { env, args, version }` plain-object form is rejected. `claude` and `codex` are present without being declared.
- **Consequences:**
  - Hooks are arbitrary host code from `wtc.setup.ts`; the setup file was already trusted code, so this adds no new trust boundary.
  - A variant's `configDir` gets its own container dir, so its container-side state and login never mix with the base agent's.
