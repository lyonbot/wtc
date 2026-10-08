import { homedir } from "node:os";
import { WtcError } from "../errors";
import { detectPlatform } from "./platform";
import type { ContainerInfo, ContainerStats, ContainerState, CreateSpec, ExecOpts, ExecResult, PlatformInfo, Runtime, RuntimeMount } from "./types";

export interface SpawnOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  /** called for each stdout/stderr line as it arrives */
  onLine?: (line: string) => void;
  /** stdin bytes; stdin is closed when omitted */
  input?: Uint8Array;
}
export type SpawnFn = (argv: string[], opts: SpawnOpts) => Promise<ExecResult>;

async function readLines(stream: ReadableStream<Uint8Array>, onLine?: (l: string) => void): Promise<string> {
  const dec = new TextDecoder();
  let all = "";
  let buf = "";
  for await (const chunk of stream) {
    const s = dec.decode(chunk, { stream: true });
    all += s;
    if (!onLine) continue;
    buf += s;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (onLine && buf) onLine(buf);
  return all;
}

const bunSpawn: SpawnFn = async (argv, opts) => {
  let proc;
  try {
    proc = Bun.spawn(argv, { env: opts.env, stdout: "pipe", stderr: "pipe", stdin: opts.input ?? "ignore" });
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: String((e as Error).message ?? e) };
  }
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    readLines(proc.stdout as ReadableStream<Uint8Array>, opts.onLine),
    readLines(proc.stderr as ReadableStream<Uint8Array>, opts.onLine),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

const mountArgs = (m: RuntimeMount): string[] =>
  m.type === "bind" && m.createMissing
    ? ["-v", `${m.source}:${m.target}${m.readonly ? ":ro" : ""}`]
    : ["--mount", `type=${m.type},src=${m.source},dst=${m.target}${m.readonly ? ",readonly" : ""}`];
const NEVER_STARTED = /^0001-01-01/;

function toInfo(j: any): ContainerInfo {
  const started: string = j.State?.StartedAt ?? "";
  return {
    id: j.Id,
    name: String(j.Name ?? "").replace(/^\//, ""),
    image: j.Config?.Image ?? "",
    labels: j.Config?.Labels ?? {},
    state: (j.State?.Status ?? "created") as ContainerState,
    startedAt: NEVER_STARTED.test(started) ? "" : started,
  };
}

export class DockerCliRuntime implements Runtime {
  private bin: string;
  private env: Record<string, string | undefined>;
  private spawn: SpawnFn;
  private hostPlatform: string;
  private home: string;

  constructor(o: { bin?: string; env?: Record<string, string>; spawn?: SpawnFn; hostPlatform?: string; home?: string } = {}) {
    this.bin = o.bin ?? "docker";
    this.env = { ...process.env, ...o.env };
    this.spawn = o.spawn ?? bunSpawn;
    this.hostPlatform = o.hostPlatform ?? process.platform;
    this.home = o.home ?? homedir();
  }

  /** Run docker; non-zero exit throws unless `allow` matches stderr. */
  private async run(args: string[], opts: SpawnOpts = {}, allow?: RegExp): Promise<ExecResult> {
    const r = await this.spawn([this.bin, ...args], { env: this.env as Record<string, string>, ...opts });
    if (r.exitCode !== 0 && !(allow && allow.test(r.stderr))) this.fail(r);
    return r;
  }
  private fail(r: ExecResult): never {
    const msg = r.stderr.trim() || `docker exited with ${r.exitCode}`;
    if (/Cannot connect to the Docker daemon|error during connect|Is the docker daemon running/i.test(msg) || r.exitCode === 127) {
      throw new WtcError("RUNTIME_UNAVAILABLE", msg, "run wtc doctor");
    }
    throw new WtcError("RUNTIME_ERROR", msg);
  }

  async platform(): Promise<PlatformInfo> {
    const r = await this.run(["info", "--format", "{{json .}}"]);
    return detectPlatform(JSON.parse(r.stdout), { platform: this.hostPlatform, home: this.home, env: { ...this.env } });
  }

  async build(o: { context: string; dockerfile: string; tag: string; buildArgs: Record<string, string>; onLog?: (line: string) => void }) {
    const args = ["build", "--progress=plain", "-f", `${o.context}/${o.dockerfile}`, "-t", o.tag];
    for (const [k, v] of Object.entries(o.buildArgs)) args.push("--build-arg", `${k}=${v}`);
    args.push(o.context);
    await this.run(args, { onLine: o.onLog });
  }
  async imageLs(repo: string) {
    const r = await this.run(["image", "ls", repo, "--format", "{{json .}}"]);
    return lines(r.stdout).map((l) => {
      const j = JSON.parse(l);
      return { ref: `${j.Repository}:${j.Tag}`, id: j.ID as string };
    });
  }
  async imageRm(ref: string) {
    await this.run(["image", "rm", ref]);
  }

  async create(s: CreateSpec) {
    const a = ["create", "--init", "--restart", "unless-stopped", "--name", s.name];
    for (const [k, v] of Object.entries(s.labels)) a.push("-l", `${k}=${v}`);
    for (const [k, v] of Object.entries(s.env)) a.push("-e", `${k}=${v}`);
    for (const m of s.mounts) a.push(...mountArgs(m));
    for (const p of s.ports) a.push("-p", `${p.hostIp}:${p.hostPort}:${p.containerPort}`);
    for (const h of s.extraHosts) a.push("--add-host", h);
    if (s.workdir) a.push("-w", s.workdir);
    const [entry, ...rest] = s.entrypoint;
    if (entry) a.push("--entrypoint", entry);
    a.push(s.image, ...rest);
    await this.run(a);
  }
  async start(name: string) {
    const r = await this.spawn([this.bin, "start", name], { env: this.env as Record<string, string> });
    if (r.exitCode === 0) return;
    if (/port is already allocated|address already in use/i.test(r.stderr)) {
      throw new WtcError("PORT_IN_USE", r.stderr.trim());
    }
    this.fail(r);
  }
  async stop(name: string, timeoutSec?: number) {
    await this.run(["stop", ...(timeoutSec !== undefined ? ["-t", String(timeoutSec)] : []), name]);
  }
  async restart(name: string, timeoutSec?: number) {
    await this.run(["restart", ...(timeoutSec !== undefined ? ["-t", String(timeoutSec)] : []), name]);
  }
  async rm(name: string, force?: boolean) {
    await this.run(["rm", ...(force ? ["-f"] : []), name]);
  }

  async exec(name: string, cmd: string[], o: ExecOpts = {}) {
    const a = ["exec"];
    if (o.input) a.push("-i");
    for (const [k, v] of Object.entries(o.env ?? {})) a.push("-e", `${k}=${v}`);
    if (o.workdir) a.push("-w", o.workdir);
    a.push(name, ...cmd);
    // exec returns the command's own exit code; only docker-level failures throw
    const r = await this.spawn([this.bin, ...a], {
      env: this.env as Record<string, string>, timeoutMs: o.timeoutMs, input: o.input, onLine: o.onLine,
    });
    if (/Cannot connect to the Docker daemon/i.test(r.stderr)) this.fail(r);
    return r;
  }
  async execInteractive(name: string, cmd: string[], o: { workdir?: string; tty?: boolean; env?: Record<string, string> } = {}) {
    const a = [this.bin, "exec", "-i"];
    if (o.tty ?? process.stdin.isTTY) a.push("-t");
    for (const [k, v] of Object.entries(o.env ?? {})) a.push("-e", `${k}=${v}`);
    if (o.workdir) a.push("-w", o.workdir);
    a.push(name, ...cmd);
    const p = Bun.spawn(a, { env: this.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await p.exited;
  }

  async inspect(name: string) {
    const r = await this.run(["inspect", "--type", "container", "--format", "{{json .}}", name], {}, /No such (object|container)/i);
    if (r.exitCode !== 0) return null;
    return toInfo(JSON.parse(r.stdout));
  }
  async ps(labels: Record<string, string>) {
    const entries = Object.entries(labels);
    // empty => every wtc container (label key presence)
    const filters = entries.length ? entries.map(([k, v]) => `label=${k}=${v}`) : ["label=wtc.setup"];
    const r = await this.run(["ps", "-a", "-q", "--no-trunc", ...filters.flatMap((f) => ["--filter", f])]);
    const ids = lines(r.stdout);
    if (!ids.length) return [];
    const i = await this.run(["inspect", "--type", "container", "--format", "{{json .}}", ...ids]);
    return lines(i.stdout).map((l) => toInfo(JSON.parse(l)));
  }
  async stats(names: string[]) {
    if (!names.length) return {};
    const r = await this.run(["stats", "--no-stream", "--format", "{{json .}}", ...names], {}, /No such container/i);
    const out: Record<string, ContainerStats> = {};
    for (const l of lines(r.stdout)) {
      const j = JSON.parse(l);
      const [used, limit] = String(j.MemUsage ?? "").split("/");
      out[String(j.Name)] = { cpuPercent: parseFloat(j.CPUPerc) || 0, memBytes: parseDockerSize(used), memLimitBytes: parseDockerSize(limit) };
    }
    return out;
  }
  async port(name: string, containerPort: number) {
    const r = await this.run(["port", name, `${containerPort}/tcp`], {}, /No public port|No such/i);
    if (r.exitCode !== 0) return null;
    for (const l of lines(r.stdout)) {
      const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(l);
      if (m) return { hostIp: m[1]!, hostPort: Number(m[2]) };
    }
    return null;
  }

  async volumeCreate(name: string, labels: Record<string, string>) {
    const a = ["volume", "create"];
    for (const [k, v] of Object.entries(labels)) a.push("--label", `${k}=${v}`);
    await this.run([...a, name]);
  }
  async volumeRm(name: string) {
    await this.run(["volume", "rm", name]);
  }
  async volumeLs(labels: Record<string, string>) {
    const entries = Object.entries(labels);
    const filters = entries.length ? entries.map(([k, v]) => `label=${k}=${v}`) : ["label=wtc.setup"];
    const r = await this.run(["volume", "ls", "-q", ...filters.flatMap((f) => ["--filter", f])]);
    const names = lines(r.stdout);
    if (!names.length) return [];
    const i = await this.run(["volume", "inspect", "--format", "{{json .}}", ...names]);
    return lines(i.stdout).map((l) => {
      const j = JSON.parse(l);
      return { name: j.Name as string, labels: (j.Labels ?? {}) as Record<string, string> };
    });
  }

  async runOnce(o: { image: string; cmd: string[]; mounts: RuntimeMount[]; env?: Record<string, string> }) {
    const a = ["run", "--rm"];
    for (const [k, v] of Object.entries(o.env ?? {})) a.push("-e", `${k}=${v}`);
    for (const m of o.mounts) a.push(...mountArgs(m));
    a.push(o.image, ...o.cmd);
    return await this.spawn([this.bin, ...a], { env: this.env as Record<string, string> });
  }
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
/** "12.3MiB" / "1.5GB" (docker stats notation) -> bytes; 0 when unparsable. */
export function parseDockerSize(s: string | undefined): number {
  const m = /^\s*([\d.]+)\s*([a-zA-Z]*)\s*$/.exec(s ?? "");
  return m ? Math.round(Number(m[1]) * (SIZE_UNITS[m[2]!.toLowerCase() || "b"] ?? 0)) : 0;
}
function lines(s: string) {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}
