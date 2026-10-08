# 0006: Host-side lock between `wtc gc` and instance creation

- **Status:** accepted (2026-10-08)
- **Context:** `up` creates instance volumes and `.wtc/run|log/<name>` before the container exists. A concurrent `wtc gc` sees them as orphans and deletes them.
- **Decision:**
  - Files in `<setup>/.wtc/lock/` (JSON `{pid, op, since}`): `gc.<token>.lock` (exclusive, real gc runs only; `--dry-run` takes none) and `create.<name>.<token>.lock` (lease held by `up`'s create branch, from before the hook/build until the container exists). The per-acquisition token means a release never removes another holder's file.
  - Files appear atomically (temp + rename). Each side writes its own file, then looks for the others', so one of two racing sides always backs off (both may, which only fails gc early). Dead-pid or unparsable files are stale and removed.
  - `gc` fails at once with `LOCKED`; `up` waits up to 10s for a running gc, then fails with `LOCKED`. Errors print the lock file path.
  - Implementation: [src/instance/lock.ts](../../packages/wtc/src/instance/lock.ts), used by [instance.ts](../../packages/wtc/src/instance/instance.ts) and [ops/gc.ts](../../packages/wtc/src/ops/gc.ts).
- **Consequences:**
  - Same-host only (pid liveness); the setup dir is host-local anyway.
  - A reused pid makes a stale file look live; the `LOCKED` message names the file so the user can delete it.
  - `rm` is not locked: it deletes the same things gc would.
