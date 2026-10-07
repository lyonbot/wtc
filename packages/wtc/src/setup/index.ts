/** Public entry for `@lyonbot/wtc/setup`: what a `wtc.setup.ts` needs (manifest types, `defineSetup`, agent definition helpers). */
export * from "./schema";
export { defineAgent, extendAgent, type AgentContext, type AgentDefinition, type AgentEnvSpec, type AgentOptions } from "../agent/define";
export { defineClaudeAgent, type ClaudeAgentOptions } from "../agent/claude";
export { defineCodexAgent, type CodexAgentOptions } from "../agent/codex";
