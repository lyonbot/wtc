import { homedir } from "node:os";
import { z } from "zod";
import { defineClaudeAgent } from "../agent/claude";
import { defineCodexAgent } from "../agent/codex";
import { type AgentDefinition, isAgentDefinition } from "../agent/define";
import { ANNOTATION_LABEL_PREFIX, ID_RE } from "../naming";

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

/** Annotations are mirrored to docker labels `wtc.ann.<key>`: keep keys label-safe and each label under the containerd-style 4096-byte (key + value) cap. */
const annotationKey = z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/, "annotation keys: lowercase alphanumerics separated by single '.' or '-'");
const MAX_LABEL_BYTES = 4096;
const MAX_ANNOTATIONS = 64;

const containerSchema = z.object({
  mounts: z.array(mount).default([]),
  hostForwards: z.array(port).default([]),
  env: z.record(envKey.refine((k) => !k.startsWith("WTC_"), "env keys starting with WTC_ are reserved"), z.string()).default({}),
  annotations: z.record(annotationKey, z.string()).default({}).superRefine((a, ctx) => {
    const entries = Object.entries(a);
    if (entries.length > MAX_ANNOTATIONS) ctx.addIssue({ code: "custom", message: `at most ${MAX_ANNOTATIONS} annotations` });
    for (const [k, v] of entries) {
      const bytes = Buffer.byteLength(ANNOTATION_LABEL_PREFIX + k) + Buffer.byteLength(v);
      if (bytes > MAX_LABEL_BYTES) ctx.addIssue({ code: "custom", path: [k], message: `label ${ANNOTATION_LABEL_PREFIX}${k} is ${bytes} bytes (key + value), max ${MAX_LABEL_BYTES}` });
    }
  }),
}).strict();

/** Validates the result of a function-valued `container`. */
export const manifestContainerSchema = containerSchema;

const hook = <F extends (...a: never[]) => unknown>() => z.custom<F>((v) => typeof v === "function", "must be a function");

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
  socksPort: port.default(1080),
  socksBind: z.string().default("0.0.0.0"),
  socksAuth: z.object({ user: z.string(), pass: z.string() }).optional(),
  socksHostPortRange: z.tuple([port, port]).default([21080, 21179]),
  preRemove: z.string().optional(),
  readyTimeout: z.number().positive().default(900),
  ssh: z.object({ knownHosts: z.array(z.string()).default([]) }).default({}),
  agents,
  hooks: z.object({ preBoot: hook<BootHook>().optional() }).strict().default({}),
  container: z.union([hook<ContainerFn>(), containerSchema]).default({}),
}).strict().superRefine((m, ctx) => {
  if (typeof m.container !== "function")
    for (const message of containerIssues(m.container, m.socksPort)) ctx.addIssue({ code: "custom", path: ["container"], message });
  if (m.socksHostPortRange[0] > m.socksHostPortRange[1])
    ctx.addIssue({ code: "custom", path: ["socksHostPortRange"], message: "range start must be <= end" });
});

/** What triggered a boot: the `wtc` command (or library call) of the same name. `up` covers both create and starting a stopped instance. */
export type BootEvent = "up" | "start" | "restart";

/** Argument of {@link SetupHooks.preBoot}. */
export interface BootHookContext {
  /** Instance name. */
  name: string;
  event: BootEvent;
  /** Absolute setup directory (where `wtc.setup.ts` lives). */
  setupDir: string;
  /**
   * The instance's effective config: freshly resolved for a create, otherwise the saved snapshot (what the
   * container was created with, not a re-evaluation). Use it to prepare the host for exactly that config,
   * e.g. create bind-source dirs or check the services behind `container.hostForwards`.
   */
  config: ConfigSnapshot;
}

export type BootHook = (ctx: BootHookContext) => void | Promise<void>;

/**
 * Host-side lifecycle hooks, written as plain TS functions (they run on the host, not in the container;
 * for container-side logic use `init.sh` / `preRemove`).
 *
 * `wtc.setup.ts` is imported by *every* command (`ls`, `status`, ...), so keep its top level free of side
 * effects and put work here instead.
 */
export interface SetupHooks {
  /**
   * Runs on the host right before a container is created or (re)started, i.e. before `init.sh` will run.
   * On create it runs after a function-valued `container` has been evaluated (so it sees `ctx.config`), and before
   * bind sources are checked, so it may create them.
   * Fires for `up` (when it has to create or start the instance), `start` (when stopped) and `restart`;
   * not for no-op calls like `up` on a ready instance. Typical use: refresh host git checkouts that
   * `init.sh` clones from.
   *
   * It is awaited with no timeout (enforce your own). If it throws or rejects, the boot is aborted with
   * `HOOK_FAILED`; catch inside the hook to make a step best-effort.
   */
  preBoot?: BootHook;
}

/** Cross-field problems of a resolved container config (shared by load-time and create-time validation). */
export function containerIssues(c: ContainerConfig, socksPort: number): string[] {
  const out: string[] = [];
  if (c.hostForwards.includes(socksPort)) out.push("socksPort must not appear in hostForwards");
  const seen = new Set<string>();
  for (const m of c.mounts) {
    if (seen.has(m.target)) out.push(`duplicate mount target ${m.target}`);
    seen.add(m.target);
  }
  return out;
}

/** Argument of a function-valued {@link Manifest.container}. */
export interface ContainerContext {
  /** Instance name. */
  name: string;
  /** Resolved params (defaults applied), i.e. what `wtc up --set K=V` produced. */
  params: Record<string, string>;
  /** Absolute setup directory. */
  setupDir: string;
}

/** Create-time container config (see {@link Manifest.container}). */
export interface ContainerConfig {
  mounts: MountInput[];
  /** Host ports reachable from the container on `127.0.0.1:<port>`. Must not contain `socksPort`. */
  hostForwards: number[];
  /** Extra container env. Keys starting with `WTC_` are reserved and must not collide with param names. */
  env: Record<string, string>;
  /**
   * Free-form metadata for your own tooling, never interpreted by wtc. Stored in the config snapshot and mirrored to
   * docker labels `wtc.ann.<key>` (so `docker ps --filter label=wtc.ann.<key>=<v>` works). Keys: lowercase alphanumerics
   * separated by `.` / `-`; each label (prefix + key + value) <= 4096 bytes and at most 64 annotations, otherwise
   * INVALID_MANIFEST (never truncated). Put bigger payloads in your own files.
   */
  annotations: Record<string, string>;
}

/**
 * The effective create-time config of an instance, saved as `.wtc/run/<name>/config.json`
 * (`/wtc/run/config.json` in the container) next to the redacted container `spec`.
 */
export interface ConfigSnapshot {
  params: Record<string, string>;
  container: ContainerConfig;
}

export type ContainerInput = z.input<typeof containerSchema>;

/**
 * Function form of `container`: called once when an instance is created (before `hooks.preBoot`, which
 * receives its result as `ctx.config`), and its result is validated like the static form. May be async.
 */
export type ContainerFn = (ctx: ContainerContext) => ContainerInput | Promise<ContainerInput>;

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
  socksPort: number;
  socksBind: string;
  socksAuth?: { user: string; pass: string };
  socksHostPortRange: [number, number];
  /**
   * What varies per instance and is fixed at creation: mounts, host forwards, env. Either a static object
   * or a function of `{ name, params, setupDir }` for configs that depend on `wtc up --set`. There is one
   * source only (no merging). Not re-evaluated by `start` / `restart`; the effective result is saved to
   * `.wtc/run/<name>/config.json` (also `/wtc/run/config.json` in the container).
   */
  container: ContainerConfig | ContainerFn;
  preRemove?: string;
  readyTimeout: number;
  ssh: { knownHosts: string[] };
  /** `wtc agent` targets; always contains the built-ins `claude` and `codex`. Applied at launch only (never part of the container spec). */
  agents: Record<string, AgentDefinition>;
  hooks: SetupHooks;
}

export type ManifestInput = z.input<typeof manifestSchema>;

/** Identity helper giving `wtc.setup.ts` files typed autocomplete. */
export function defineSetup(m: ManifestInput): ManifestInput {
  return m;
}
