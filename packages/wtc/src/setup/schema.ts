import { homedir } from "node:os";
import { z } from "zod";
import { ID_RE } from "../naming";

const id = z.string().regex(ID_RE, "must match ^[a-z0-9]+(-[a-z0-9]+)*$");
const port = z.number().int().min(1).max(65535);
const readonly = z.boolean().optional();
const target = z.string().refine((t) => !/^\/(wtc|pnpm)(\/|$)/.test(t), "target must not be /wtc or /pnpm (reserved)");

const mount = z.union([
  z.object({ type: z.literal("volume"), name: id, target, scope: z.enum(["setup", "instance"]), readonly }).strict(),
  z.object({ type: z.literal("volume"), external: z.string().min(1), target, readonly }).strict(),
  z.object({
    type: z.literal("bind"),
    source: z.string().min(1).transform((s) => (s === "~" || s.startsWith("~/") ? homedir() + s.slice(1) : s)),
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
const agent = z.object({
  env: z.record(envKey, z.union([z.string(), z.object({ fromHost: z.string().min(1) }).strict(), z.null()])).default({}),
  args: z.array(z.string()).default([]),
  version: z.string().min(1).default("latest"),
}).strict().default({});

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
  hostForwards: z.array(port).default([]),
  socksPort: port.default(1080),
  socksBind: z.string().default("0.0.0.0"),
  socksAuth: z.object({ user: z.string(), pass: z.string() }).optional(),
  socksHostPortRange: z.tuple([port, port]).default([21080, 21179]),
  mounts: z.array(mount).default([]),
  preRemove: z.string().optional(),
  readyTimeout: z.number().positive().default(900),
  ssh: z.object({ knownHosts: z.array(z.string()).default([]) }).default({}),
  agents: z.object({ claude: agent, codex: agent }).strict().default({}),
  hooks: z.object({ preBoot: hook<BootHook>().optional() }).strict().default({}),
}).superRefine((m, ctx) => {
  if (m.hostForwards.includes(m.socksPort))
    ctx.addIssue({ code: "custom", path: ["socksPort"], message: "socksPort must not appear in hostForwards" });
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
   * Fires for `up` (when it has to create or start the instance), `start` (when stopped) and `restart`;
   * not for no-op calls like `up` on a ready instance. Typical use: refresh host git checkouts that
   * `init.sh` clones from.
   *
   * It is awaited with no timeout (enforce your own). If it throws or rejects, the boot is aborted with
   * `HOOK_FAILED`; catch inside the hook to make a step best-effort.
   */
  preBoot?: BootHook;
}

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
  agents: Record<AgentKind, AgentConfig>;
  hooks: SetupHooks;
}

export type AgentKind = "claude" | "codex";
/** Per-agent options for `wtc agent`; applied at launch only (never part of the container spec). */
export interface AgentConfig {
  /** string = literal, `fromHost` = read from the host env at launch, null = drop a built-in variable */
  env: Record<string, string | { fromHost: string } | null>;
  /** appended after the built-in args, before CLI args */
  args: string[];
  /** npm version / dist-tag used when auto-installing */
  version: string;
}

export type ManifestInput = z.input<typeof manifestSchema>;

/** Identity helper giving `wtc.setup.ts` files typed autocomplete. */
export function defineSetup(m: ManifestInput): ManifestInput {
  return m;
}
