export type ContainerState = "created" | "running" | "exited" | "paused" | "restarting" | "dead" | "removing";
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  state: ContainerState;
  /** ISO timestamp, "" if never started */
  startedAt: string;
}
export type RuntimeMount = {
  type: "volume" | "bind";
  source: string;
  target: string;
  readonly?: boolean;
  /** bind only: source may be missing on the runtime host; emitted as `-v` (docker creates it) instead of `--mount` (which fails) */
  createMissing?: boolean;
};
export interface CreateSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: RuntimeMount[];
  ports: { hostIp: string; hostPort: number; containerPort: number }[];
  entrypoint: string[];
  extraHosts: string[];
  workdir?: string;
}
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface ExecOpts {
  env?: Record<string, string>;
  workdir?: string;
  timeoutMs?: number;
  /** bytes fed to the command's stdin (adds `docker exec -i`) */
  input?: Uint8Array;
  /** called for each stdout/stderr line as it arrives */
  onLine?: (line: string) => void;
}
export interface PlatformInfo {
  kind: "linux" | "colima" | "other";
  arch: "amd64" | "arm64";
  /** host path to bind at /wtc/ssh-agent.sock; undefined = none */
  sshAgentSource?: string;
  /** add --add-host=host.docker.internal:host-gateway */
  hostGatewayFlag: boolean;
  /** colima: [homedir]; linux: undefined (any path) */
  bindableRoots?: string[];
}
export interface Runtime {
  platform(): Promise<PlatformInfo>;
  build(o: { context: string; dockerfile: string; tag: string; buildArgs: Record<string, string>; onLog?: (line: string) => void }): Promise<void>;
  imageLs(repo: string): Promise<{ ref: string; id: string }[]>;
  imageRm(ref: string): Promise<void>;
  create(spec: CreateSpec): Promise<void>;
  /** throws WtcError "PORT_IN_USE" when the port is taken */
  start(name: string): Promise<void>;
  stop(name: string, timeoutSec?: number): Promise<void>;
  restart(name: string, timeoutSec?: number): Promise<void>;
  rm(name: string, force?: boolean): Promise<void>;
  exec(name: string, cmd: string[], o?: ExecOpts): Promise<ExecResult>;
  /** inherits stdio, returns exit code */
  execInteractive(name: string, cmd: string[], o?: { workdir?: string; tty?: boolean; env?: Record<string, string> }): Promise<number>;
  inspect(name: string): Promise<ContainerInfo | null>;
  /** Includes stopped containers. Empty `labels` = all wtc containers (those carrying label key `wtc.setup`). */
  ps(labels: Record<string, string>): Promise<ContainerInfo[]>;
  port(name: string, containerPort: number): Promise<{ hostIp: string; hostPort: number } | null>;
  volumeCreate(name: string, labels: Record<string, string>): Promise<void>;
  volumeRm(name: string): Promise<void>;
  volumeLs(labels: Record<string, string>): Promise<{ name: string; labels: Record<string, string> }[]>;
  /** docker run --rm */
  runOnce(o: { image: string; cmd: string[]; mounts: RuntimeMount[]; env?: Record<string, string> }): Promise<ExecResult>;
}
