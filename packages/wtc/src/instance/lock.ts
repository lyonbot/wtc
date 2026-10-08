import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WtcError } from "../errors";

/**
 * Host-side lock between `wtc gc` (exclusive) and instance creation (shared leases), so gc never deletes the
 * volumes / run dirs a concurrent `wtc up` has just made but not yet attached to a container.
 *
 * Files in `<setup>/.wtc/lock/` (JSON `{pid, op, since}`): `gc.<token>.lock`, `create.<name>.<token>.lock`; the token is
 * unique per acquisition, so releasing never removes another holder's file and a stale file is never rewritten.
 * Files appear atomically (temp + rename). Each side writes its own file first and then looks for the others', so at
 * least one of two racing sides sees the other and backs off. A file whose pid is dead (or that is unparsable) is stale: removed.
 */
export const lockDir = (setupDir: string) => join(setupDir, ".wtc", "lock");

export interface LockHolder { file: string; pid: number; op: string; since: string }

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
};

const GC_RE = /^gc\..+\.lock$/;
const CREATE_RE = /^create\..+\.lock$/;

/** Live holders of lock files whose name matches `re`, other than `self`. Stale and unparsable files are removed. */
async function holders(dir: string, re: RegExp, alive: (pid: number) => boolean, self?: string): Promise<LockHolder[]> {
  const out: LockHolder[] = [];
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const file = join(dir, f);
    if (!re.test(f) || file === self) continue;
    const text = await readFile(file, "utf8").catch(() => undefined); // released meanwhile
    if (text === undefined) continue;
    let h: Omit<LockHolder, "file"> | undefined;
    try {
      h = JSON.parse(text);
    } catch {}
    if (h && typeof h === "object" && Number.isInteger(h.pid) && h.pid > 0 && alive(h.pid)) out.push({ ...h, file });
    else await rm(file, { force: true });
  }
  return out;
}

const describe = (h: LockHolder) => `${h.op} (pid ${h.pid}, since ${h.since}); lock file: ${h.file}`;
const hint = "wait for it to finish; if that pid is no longer a wtc process, delete the lock file";

async function acquire(dir: string, prefix: string, op: string): Promise<{ path: string; release: () => Promise<void> }> {
  await mkdir(dir, { recursive: true });
  const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const path = join(dir, `${prefix}.${token}.lock`);
  const tmp = join(dir, `.${token}.tmp`);
  await writeFile(tmp, JSON.stringify({ pid: process.pid, op, since: new Date().toISOString() }));
  await rename(tmp, path);
  return { path, release: () => rm(path, { force: true }) };
}

/** Exclusive lock for a real `wtc gc`. Fails at once with `LOCKED` (naming the lock file) while a create or another gc is running. */
export async function acquireGc(setupDir: string, alive = pidAlive): Promise<() => Promise<void>> {
  const dir = lockDir(setupDir);
  const { path, release } = await acquire(dir, "gc", "gc");
  const gc = (await holders(dir, GC_RE, alive, path))[0];
  const create = gc ? undefined : (await holders(dir, CREATE_RE, alive))[0];
  if (gc || create) {
    await release();
    if (gc) throw new WtcError("LOCKED", `another gc is running: ${describe(gc)}`, hint);
    throw new WtcError("LOCKED", `cannot gc while an instance is being created: ${describe(create!)}`, hint);
  }
  return release;
}

/** Shared lease held while creating instance `name`. Waits up to `waitMs` for a running gc, then fails with `LOCKED`. */
export async function acquireCreate(setupDir: string, name: string, o: { waitMs?: number; alive?: (pid: number) => boolean } = {}): Promise<() => Promise<void>> {
  const dir = lockDir(setupDir);
  const alive = o.alive ?? pidAlive;
  const deadline = Date.now() + (o.waitMs ?? 10_000);
  for (;;) {
    const { release } = await acquire(dir, `create.${name}`, `create ${name}`);
    const gc = (await holders(dir, GC_RE, alive))[0];
    if (!gc) return release;
    await release();
    if (Date.now() >= deadline) throw new WtcError("LOCKED", `gc is running: ${describe(gc)}`, hint);
    await new Promise((r) => setTimeout(r, 200));
  }
}
