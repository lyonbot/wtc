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

## Note (2026-10-08): gc hardening

- A failed removal no longer aborts gc: it is reported in `failed` and the run continues; a failed `--prune-store` carries `storeError` (pnpm output tail). Any failure exits 1.
- gc refuses with `SETUP_ID_CONFLICT` (dry run too) when a container or instance volume of its `id` carries another `wtc.setupDir`: images have no setup-dir label, so gc cannot tell whose they are. Setup-scope volumes are exempt (shared, labelled by their first creator). See [ops/gc.ts](../../packages/wtc/src/ops/gc.ts).
