import { WtcError } from "../errors";
import type { ContainerInfo, CreateSpec, ExecResult, PlatformInfo, Runtime, RuntimeMount } from "./types";

/** In-memory Runtime for tests. Records every call in `calls`. */
export class FakeRuntime implements Runtime {
  calls: { op: string; args: unknown[] }[] = [];
  failNextStart?: WtcError;
  execHandler?: (name: string, cmd: string[]) => ExecResult;
  platformInfo: PlatformInfo = { kind: "linux", arch: "amd64", hostGatewayFlag: true };
  containers = new Map<string, { info: ContainerInfo; spec: CreateSpec }>();
  volumes = new Map<string, Record<string, string>>();
  images: { ref: string; id: string }[] = [];
  /** ports assigned to containers, keyed by name -> containerPort */
  private clock: () => string;
  private nextId = 1;

  constructor(o: { now?: () => string } = {}) {
    this.clock = o.now ?? (() => new Date().toISOString());
  }

  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  private get(name: string) {
    const c = this.containers.get(name);
    if (!c) throw new WtcError("RUNTIME_ERROR", `No such container: ${name}`);
    return c;
  }

  async platform() { this.rec("platform"); return this.platformInfo; }
  async build(o: Parameters<Runtime["build"]>[0]) {
    this.rec("build", o);
    this.images.push({ ref: o.tag, id: `sha256:fake${this.nextId++}` });
  }
  async imageLs(repo: string) {
    this.rec("imageLs", repo);
    return this.images.filter((i) => i.ref.split(":")[0] === repo);
  }
  async imageRm(ref: string) {
    this.rec("imageRm", ref);
    this.images = this.images.filter((i) => i.ref !== ref);
  }
  async create(spec: CreateSpec) {
    this.rec("create", spec);
    if (this.containers.has(spec.name)) throw new WtcError("RUNTIME_ERROR", `Conflict. container name ${spec.name} is already in use`);
    this.containers.set(spec.name, {
      spec,
      info: { id: `fake${this.nextId++}`, name: spec.name, image: spec.image, labels: { ...spec.labels }, state: "created", startedAt: "" },
    });
  }
  async start(name: string) {
    this.rec("start", name);
    if (this.failNextStart) {
      const e = this.failNextStart;
      this.failNextStart = undefined;
      throw e;
    }
    const c = this.get(name);
    c.info.state = "running";
    c.info.startedAt = this.clock();
  }
  async stop(name: string, timeoutSec?: number) {
    this.rec("stop", name, timeoutSec);
    this.get(name).info.state = "exited";
  }
  async restart(name: string, timeoutSec?: number) {
    this.rec("restart", name, timeoutSec);
    const c = this.get(name);
    c.info.state = "running";
    c.info.startedAt = this.clock();
  }
  async rm(name: string, force?: boolean) {
    this.rec("rm", name, force);
    const c = this.get(name);
    if (c.info.state === "running" && !force) throw new WtcError("RUNTIME_ERROR", `cannot remove running container ${name}`);
    this.containers.delete(name);
  }
  async exec(name: string, cmd: string[], o?: { env?: Record<string, string>; workdir?: string; timeoutMs?: number }) {
    this.rec("exec", name, cmd, o);
    this.get(name);
    return this.execHandler ? this.execHandler(name, cmd) : { exitCode: 0, stdout: "", stderr: "" };
  }
  async execInteractive(name: string, cmd: string[], o?: { workdir?: string; tty?: boolean }) {
    this.rec("execInteractive", name, cmd, o);
    return (await this.exec(name, cmd)).exitCode;
  }
  async inspect(name: string) {
    this.rec("inspect", name);
    const c = this.containers.get(name);
    return c ? { ...c.info, labels: { ...c.info.labels } } : null;
  }
  async ps(labels: Record<string, string>) {
    this.rec("ps", labels);
    const entries = Object.entries(labels);
    return [...this.containers.values()]
      .map((c) => c.info)
      .filter((i) => (entries.length ? entries.every(([k, v]) => i.labels[k] === v) : "wtc.setup" in i.labels));
  }
  async port(name: string, containerPort: number) {
    this.rec("port", name, containerPort);
    const p = this.get(name).spec.ports.find((x) => x.containerPort === containerPort);
    return p ? { hostIp: p.hostIp, hostPort: p.hostPort } : null;
  }
  async volumeCreate(name: string, labels: Record<string, string>) {
    this.rec("volumeCreate", name, labels);
    this.volumes.set(name, { ...labels });
  }
  async volumeRm(name: string) {
    this.rec("volumeRm", name);
    this.volumes.delete(name);
  }
  async volumeLs(labels: Record<string, string>) {
    this.rec("volumeLs", labels);
    const entries = Object.entries(labels);
    return [...this.volumes]
      .filter(([, l]) => entries.every(([k, v]) => l[k] === v))
      .map(([name, l]) => ({ name, labels: { ...l } }));
  }
  async runOnce(o: { image: string; cmd: string[]; mounts: RuntimeMount[]; env?: Record<string, string> }) {
    this.rec("runOnce", o);
    return this.execHandler ? this.execHandler("", o.cmd) : { exitCode: 0, stdout: "", stderr: "" };
  }
}
