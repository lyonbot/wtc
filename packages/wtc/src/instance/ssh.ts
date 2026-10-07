import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG = "Host *\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ~/.ssh/known_hosts\n";

/**
 * Write `dir/config` and `dir/known_hosts` (mounted at /wtc/ssh, copied to ~/.ssh by wtc-entry, spec §6.4).
 * known_hosts entries come only from the host's `~/.ssh/known_hosts` via `ssh-keygen -F`;
 * hosts without an entry are skipped and reported in `warnings`.
 */
export async function prepareSshDir(o: { dir: string; knownHosts: string[]; home: string }): Promise<{ warnings: string[] }> {
  await mkdir(o.dir, { recursive: true });
  await writeFile(join(o.dir, "config"), CONFIG);
  const src = join(o.home, ".ssh", "known_hosts");
  const lines: string[] = [];
  const warnings: string[] = [];
  for (const host of o.knownHosts) {
    const r = spawnSync("ssh-keygen", ["-F", host, "-f", src], { encoding: "utf8" });
    const found = r.status === 0 ? (r.stdout ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#")) : [];
    if (found.length) lines.push(...found);
    else warnings.push(`no known_hosts entry for ${host} in ${src}; ssh to it once on the host first`);
  }
  await writeFile(join(o.dir, "known_hosts"), lines.length ? lines.join("\n") + "\n" : "");
  return { warnings };
}
