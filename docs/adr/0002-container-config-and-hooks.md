# 0002: `container` config + host-side hooks

- **Status:** accepted (2026-10-07)
- **Decision:** per-instance create-time config (`mounts`, `hostForwards`, `env`, `annotations`) moves under `container`, as a static object **or** a function of `{ name, params, setupDir }`; host-side logic is expressed as `hooks.preBoot` instead of sniffing `process.argv` in `wtc.setup.ts`.
- **Why:** the manifest is imported by every command, so config depending on `--set` cannot be a top-level function (params are declared in it); a single source (object or function) avoids merge/override rules.
- **Where:** [schema.ts](../../packages/wtc/src/setup/schema.ts) (types, JSDoc), [container.ts](../../packages/wtc/src/instance/container.ts) (evaluation), [instance.ts](../../packages/wtc/src/instance/instance.ts) (call sites, `config.json` snapshot).
- **Consequences:** breaking for top-level `mounts` / `hostForwards` (unknown top-level keys now rejected); the container spec stays immutable after create, so `start` / `restart` reuse the saved snapshot.
