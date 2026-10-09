import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WTC_VERSION } from "../version";
import entry from "../../kit/bin/wtc-entry" with { type: "file" };
import signal from "../../kit/bin/wtc-signal" with { type: "file" };
import install from "../../kit/bin/wtc-install" with { type: "file" };
import remark from "../../kit/bin/wtc-remark" with { type: "file" };
import kitAmd64 from "../../kit/dist/linux-amd64/wtc-kit" with { type: "file" };
import kitArm64 from "../../kit/dist/linux-arm64/wtc-kit" with { type: "file" };

/**
 * Extracts the container kit (scripts + wtc-kit for `arch`) to the cache once and returns its dir.
 * Location: `${cacheDir ?? $WTC_CACHE_DIR ?? ~/.cache/wtc}/kit/<version>-<arch>-<content hash>/`; skipped when `.complete` exists.
 */
export async function ensureKit(o: { arch: "amd64" | "arm64"; cacheDir?: string }): Promise<string> {
  const base = o.cacheDir ?? process.env.WTC_CACHE_DIR ?? join(homedir(), ".cache", "wtc");
  const files: [string, string][] = [
    ["wtc-entry", entry],
    ["wtc-signal", signal],
    ["wtc-install", install],
    ["wtc-remark", remark],
    ["wtc-kit", o.arch === "amd64" ? kitAmd64 : kitArm64],
  ];
  const contents = await Promise.all(files.map(([, src]) => readFile(src)));
  const hash = createHash("sha256");
  for (const c of contents) hash.update(c);
  const dir = join(base, "kit", `${WTC_VERSION}-${o.arch}-${hash.digest("hex").slice(0, 8)}`);
  const marker = join(dir, ".complete");
  if (await stat(marker).then(() => true, () => false)) return dir;

  await mkdir(dir, { recursive: true });
  for (const [i, [name]] of files.entries()) {
    const tmp = join(dir, `${name}.tmp.${process.pid}`);
    await writeFile(tmp, contents[i]!);
    await chmod(tmp, 0o755);
    await rename(tmp, join(dir, name));
  }
  await writeFile(marker, "");
  return dir;
}
