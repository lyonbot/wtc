import type { PlatformInfo } from "./types";

/** Pure classification of `docker info --format '{{json .}}'` output (spec §2). */
export function detectPlatform(
  info: { Name?: string; OperatingSystem?: string; Architecture?: string },
  host: { platform: string; home: string; env: Record<string, string | undefined> },
): PlatformInfo {
  const arch: PlatformInfo["arch"] = /aarch64|arm64/i.test(info.Architecture ?? "") ? "arm64" : "amd64";
  const name = (info.Name ?? "").toLowerCase();
  const os = (info.OperatingSystem ?? "").toLowerCase();
  const isColima = name.includes("colima") || os.includes("colima") || (host.platform === "darwin" && os.includes("ubuntu"));
  if (isColima) {
    return { kind: "colima", arch, sshAgentSource: "/run/host-services/ssh-auth.sock", hostGatewayFlag: false, bindableRoots: [host.home] };
  }
  if (host.platform === "linux") {
    const p: PlatformInfo = { kind: "linux", arch, hostGatewayFlag: true };
    if (host.env.SSH_AUTH_SOCK) p.sshAgentSource = host.env.SSH_AUTH_SOCK;
    return p;
  }
  return { kind: "other", arch, hostGatewayFlag: false };
}
