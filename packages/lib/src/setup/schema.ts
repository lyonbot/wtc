import { homedir } from "node:os";
import { z } from "zod";
import { defineClaudeAgent } from "../agent/claude";
import { defineCodexAgent } from "../agent/codex";
import { type AgentDefinition, isAgentDefinition } from "../agent/define";
import { ID_RE } from "../naming";

const expandHome = (s: string) => (s === "~" || s.startsWith("~/") ? homedir() + s.slice(1) : s);
const id = z.string().regex(ID_RE, "must match ^[a-z0-9]+(-[a-z0-9]+)*$");
const port = z.number().int().min(1).max(65535);
const readonly = z.boolean().optional();
const target = z.string().refine((t) => !/^\/(wtc|pnpm)(\/|$)/.test(t), "target must not be /wtc or /pnpm (reserved)");

const mount = z.union([
  z.object({ type: z.literal("volume"), name: id, target, scope: z.enum(["setup", "instance"]), readonly }).strict(),
  z.object({ type: z.literal("volume"), external: z.string().min(1), target, readonly }).strict(),
  z.object({
    type: z.literal("bind"),
    source: z.string().min(1).transform(expandHome),
    target,
    readonly,
  }).strict(),
]);

const param = z.object({
  description: z.string(),
  default: z.string().optional(),
  required: z.boolean().optional(),
  pattern: z.string().refine((p) => {
    try { new RegExp(p); return true; } catch { return false; }
  }, "pattern is not a valid RegExp").optional(),
});

const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env key must match ^[A-Z_][A-Z0-9_]*$");
const envSpec = z.record(envKey, z.union([z.string(), z.object({ fromHost: z.string().min(1) }).strict(), z.null()]));
const cmdName = z.string().regex(/^[A-Za-z0-9._+-]+$/, "must be a plain command name");
const fn = z.custom<(...a: any[]) => any>((f) => typeof f === "function", "must be a function");
const agentDef = z.object({
  bin: cmdName,
  pkg: z.string().min(1).optional(),
  version: z.string().min(1).default("latest"),
  env: envSpec.default({}),
  args: z.union([z.array(z.string()), fn]).default([]),
  probe: z.array(cmdName).default([]),
  sync: fn.optional(),
  afterSync: fn.optional(),
}).strict();
const BUILTIN_AGENTS = { claude: defineClaudeAgent, codex: defineCodexAgent } as const;

/** built-ins are always present; anything given must come from defineAgent / defineClaudeAgent / defineCodexAgent */
const agents = z.record(id, z.custom<AgentDefinition>()).default({}).transform((r, ctx) => {
  const out: Record<string, AgentDefinition> = {};
  for (const [k, v] of Object.entries({ claude: BUILTIN_AGENTS.claude(), codex: BUILTIN_AGENTS.codex(), ...r })) {
    if (!isAgentDefinition(v)) {
      const hint = k === "claude" ? "defineClaudeAgent({ … })" : k === "codex" ? "defineCodexAgent({ … })" : "defineAgent / defineClaudeAgent / defineCodexAgent";
      ctx.addIssue({ code: "custom", path: [k], message: `agents must be built with ${hint}` });
      continue;
    }
    const p = agentDef.safeParse(v);
    if (!p.success) {
      for (const i of p.error.issues) ctx.addIssue({ ...i, path: [k, ...i.path] });
      continue;
    }
    out[k] = p.data as AgentDefinition;
  }
  return out;
});

export const manifestSchema = z.object({
  id,
  image: z.object({
    context: z.string().default("image"),
    dockerfile: z.string().default("Dockerfile"),
    buildArgs: z.record(z.string()).default({}),
  }).default({}),
  init: z.string().default("init.sh"),
  params: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "param key must match ^[A-Z_][A-Z0-9_]*$"), param).default({}),
  cwd: z.string().default("/workspace"),
  scripts: z.record(z.object({ run: z.string(), description: z.string() })).default({}),
  checks: z.record(z.object({ run: z.string(), timeout: z.number().positive().default(10) })).default({}),
  hostForwards: z.array(port).default([]),
  socksPort: port.default(1080),
  socksBind: z.string().default("0.0.0.0"),
  socksAuth: z.object({ user: z.string(), pass: z.string() }).optional(),
  socksHostPortRange: z.tuple([port, port]).default([21080, 21179]),
  mounts: z.array(mount).default([]),
  preRemove: z.string().optional(),
  readyTimeout: z.number().positive().default(900),
  ssh: z.object({ knownHosts: z.array(z.string()).default([]) }).default({}),
  agents,
}).superRefine((m, ctx) => {
  if (m.hostForwards.includes(m.socksPort))
    ctx.addIssue({ code: "custom", path: ["socksPort"], message: "socksPort must not appear in hostForwards" });
  if (m.socksHostPortRange[0] > m.socksHostPortRange[1])
    ctx.addIssue({ code: "custom", path: ["socksHostPortRange"], message: "range start must be <= end" });
});

export type MountInput =
  | { type: "volume"; name: string; target: string; scope: "setup" | "instance"; readonly?: boolean }
  | { type: "volume"; external: string; target: string; readonly?: boolean }
  | { type: "bind"; source: string; target: string; readonly?: boolean };

export interface Manifest {
  id: string;
  image: { context: string; dockerfile: string; buildArgs: Record<string, string> };
  init: string;
  params: Record<string, { description: string; default?: string; required?: boolean; pattern?: string }>;
  cwd: string;
  scripts: Record<string, { run: string; description: string }>;
  checks: Record<string, { run: string; timeout: number }>;
  hostForwards: number[];
  socksPort: number;
  socksBind: string;
  socksAuth?: { user: string; pass: string };
  socksHostPortRange: [number, number];
  mounts: MountInput[];
  preRemove?: string;
  readyTimeout: number;
  ssh: { knownHosts: string[] };
  /** `wtc agent` targets; always contains the built-ins `claude` and `codex`. Applied at launch only (never part of the container spec). */
  agents: Record<string, AgentDefinition>;
}

export type ManifestInput = z.input<typeof manifestSchema>;

/** Identity helper giving `wtc.setup.ts` files typed autocomplete. */
export function defineSetup(m: ManifestInput): ManifestInput {
  return m;
}
