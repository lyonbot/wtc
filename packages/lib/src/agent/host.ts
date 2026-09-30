import { homedir } from "node:os";

/** Host facts the agent bundle reads; injectable for tests. */
export interface HostEnv {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** macOS Keychain generic password by service name; null when absent */
  readKeychain(service: string): Promise<string | null>;
}

async function securityFind(service: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

export const defaultHostEnv = (): HostEnv => ({
  home: homedir(),
  env: process.env,
  platform: process.platform,
  readKeychain: securityFind,
});
