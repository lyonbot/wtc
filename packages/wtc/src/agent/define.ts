import type { ExecResult } from "../runtime/types";
import { addDir, addFile, type Bundle } from "./bundle";
import type { HostEnv } from "./host";

/** string = literal, `fromHost` = read from the host env at launch, null = drop a variable the base agent sets */
export type AgentEnvSpec = Record<string, string | { fromHost: string } | null>;

/** What agent hooks see at launch; `env` is the resolved launch env and may be edited. */
export interface AgentContext {
  /** key under `agents` in the manifest */
  name: string;
  host: HostEnv;
  /** container $HOME */
  home: string;
  /** manifest cwd */
  cwd: string;
  env: Record<string, string>;
  /** whether a command exists in the container (bin, npm, tar, node, ps and the definition's `probe`) */
  has(cmd: string): boolean;
  /** files extracted into the container $HOME after `sync`; paths are relative to it */
  files: Bundle;
  write(dest: string, data: string | Uint8Array, mode?: string): void;
  /** host file (`~/` = host home) into the container; missing files are skipped */
  copyFile(src: string, dest: string, mode?: string): void;
  /** host dir (`~/` = host home) into the container; missing dirs are skipped */
  copyDir(src: string, dest: string, skip?: (rel: string) => boolean): void;
  /** run in the container now; a string runs under `bash -lc` */
  exec(cmd: string | string[], o?: { input?: string | Uint8Array }): Promise<ExecResult>;
  log(line: string): void;
}

export interface AgentDefinition {
  /** command in the container */
  bin: string;
  /** npm package installed globally when `bin` is missing; without it a missing bin is an error */
  pkg?: string;
  /** npm version / dist-tag for the install */
  version?: string;
  env?: AgentEnvSpec;
  /** placed before CLI args */
  args?: string[] | ((ctx: AgentContext) => string[]);
  /** extra commands to look up in the container, for `ctx.has` */
  probe?: string[];
  /** host side, every launch, before the install: collect files into `ctx.files`, adjust `ctx.env` */
  sync?(ctx: AgentContext): void | Promise<void>;
  /** after `ctx.files` landed in the container */
  afterSync?(ctx: AgentContext): void | Promise<void>;
}

/** Overrides layered onto a base definition by `extendAgent` / `defineClaudeAgent` / `defineCodexAgent`. */
export interface AgentOptions extends Partial<Pick<AgentDefinition, "bin" | "pkg" | "version" | "env" | "probe" | "sync" | "afterSync">> {
  /** appended after the base's args */
  args?: string[];
}

/** Marks values built by the define helpers; manifest `agents` accepts nothing else. Symbol.for: survives duplicate lib copies. */
const DEFINED = Symbol.for("wtc.agentDefinition");

export const isAgentDefinition = (v: unknown): v is AgentDefinition =>
  !!v && typeof v === "object" && (v as Record<symbol, unknown>)[DEFINED] === true;

/** Agent definition for `wtc.setup.ts` `agents`; the only accepted form besides defineClaudeAgent / defineCodexAgent. */
export function defineAgent(d: AgentDefinition): AgentDefinition {
  return Object.assign({ ...d }, { [DEFINED]: true });
}

/**
 * Layer `o` onto `base`: env overlaid (null drops a base variable), args appended, hooks run after the base's.
 * A renamed `bin` is a different program, so the base's `pkg` only carries over when `bin` is unchanged.
 */
export function extendAgent(base: AgentDefinition, o: AgentOptions): AgentDefinition {
  const env: AgentEnvSpec = { ...base.env };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const extra = o.args ?? [];
  const args = base.args;
  const chain = (a?: (c: AgentContext) => void | Promise<void>, b?: (c: AgentContext) => void | Promise<void>) =>
    a && b ? async (c: AgentContext) => { await a(c); await b(c); } : a ?? b;
  return defineAgent({
    bin: o.bin ?? base.bin,
    pkg: o.pkg ?? (o.bin && o.bin !== base.bin ? undefined : base.pkg),
    version: o.version ?? base.version,
    env,
    args: typeof args === "function" ? (c) => [...args(c), ...extra] : [...(args ?? []), ...extra],
    probe: [...(base.probe ?? []), ...(o.probe ?? [])],
    sync: chain(base.sync, o.sync),
    afterSync: chain(base.afterSync, o.afterSync),
  });
}

/** `~` / `~/…` against the host home. */
export const expandHost = (h: HostEnv, p: string) => (p === "~" || p.startsWith("~/") ? h.home + p.slice(1) : p);

/**
 * Container dir (relative to $HOME) for a host config dir: the same path relative to the host home,
 * else `.wtc-agents/<name>`, so agents with different config dirs never share container state.
 */
export function agentConfigTarget(hostHome: string, configDir: string, name: string): string {
  return configDir.startsWith(hostHome + "/") ? configDir.slice(hostHome.length + 1) : `.wtc-agents/${name}`;
}

/** The file helpers of AgentContext over a bundle. */
export function fileHelpers(h: HostEnv, files: Bundle): Pick<AgentContext, "write" | "copyFile" | "copyDir"> {
  return {
    write: (dest, data, mode) => files.add(dest, data, mode),
    copyFile: (src, dest, mode) => addFile(files, expandHost(h, src), dest, mode),
    copyDir: (src, dest, skip) => addDir(files, expandHost(h, src), dest, skip),
  };
}
