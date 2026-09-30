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
}

export type ManifestInput = z.input<typeof manifestSchema>;

/** Identity helper giving `wtc.setup.ts` files typed autocomplete. */
export function defineSetup(m: ManifestInput): ManifestInput {
  return m;
}
