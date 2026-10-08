// Builds kit/dist (linux wtc-kit) if missing and syncs it into packages/wtc/kit so plain `bun test` is self-contained.
import { existsSync } from "node:fs";
import { join } from "node:path";

const kit = join(import.meta.dir, "..");
if (!["amd64", "arm64"].every((a) => existsSync(join(kit, "dist", `linux-${a}`, "wtc-kit")))) {
  const r = Bun.spawnSync(["bash", join(kit, "build.sh")], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error("kit/build.sh failed");
}
// always re-sync: kit/bin scripts may have changed since the last build
const s = Bun.spawnSync(["bash", join(kit, "sync.sh")], { stdout: "inherit", stderr: "inherit" });
if (s.exitCode !== 0) throw new Error("kit/sync.sh failed");
