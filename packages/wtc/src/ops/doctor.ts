import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceContext } from "../instance/instance";
import { imageRef } from "../naming";
import { computeImageHash } from "../setup/image-hash";
import { hasImage } from "./build";
import { noProxyLoopback } from "./common";

export interface DoctorCheck { name: string; ok: boolean; detail: string; hint?: string }

/** Environment diagnostics (no firewall check in v1). Never throws: each check reports ok/detail/hint. */
export async function doctor(ctx: InstanceContext): Promise<{ checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, hint?: string) => checks.push({ name, ok, detail, ...(hint ? { hint } : {}) });
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let plat: Awaited<ReturnType<InstanceContext["rt"]["platform"]>> | undefined;
  try {
    plat = await ctx.rt.platform();
    add("runtime", true, "reachable");
    add("platform", true, `${plat.kind}/${plat.arch}`);
  } catch (e) {
    add("runtime", false, msg(e), "start docker / colima (e.g. `colima start`)");
  }

  if (plat?.kind === "colima") {
    try {
      const y = await readFile(join(ctx.home, ".colima", "default", "colima.yaml"), "utf8");
      const ok = /^\s*forwardAgent:\s*true\s*$/m.test(y);
      add("colima-forwardAgent", ok, ok ? "forwardAgent: true" : "forwardAgent is not true", ok ? undefined : "set `forwardAgent: true` in ~/.colima/default/colima.yaml and restart colima (needed for ssh agent)");
    } catch (e) {
      add("colima-forwardAgent", false, `cannot read colima.yaml: ${msg(e)}`, "profile other than `default`? check forwardAgent manually");
    }
  }

  if (plat) {
    const roots = plat.bindableRoots;
    const dir = ctx.setup.dir;
    const ok = !roots || roots.some((r) => dir === r || dir.startsWith(r.endsWith("/") ? r : r + "/"));
    add("setup-dir", ok, dir, ok ? undefined : `move the setup under ${roots!.join(" or ")} (colima only mounts these)`);

    try {
      const ref = imageRef(ctx.setup.manifest.id, await computeImageHash(ctx.setup));
      if (await hasImage(ctx, ref)) {
        const r = await ctx.rt.runOnce({
          image: ref,
          cmd: ["bash", "-lc", "command -v git node pnpm flock ssh && node -v && pnpm -v"],
          mounts: [],
        });
        const out = (r.stdout + r.stderr).trim();
        add("toolchain", r.exitCode === 0, r.exitCode === 0 ? out.split("\n").slice(-2).join(" / ") : out || `exit ${r.exitCode}`, r.exitCode === 0 ? undefined : "image must provide git node pnpm flock ssh");
      } else {
        add("toolchain", true, "image not built yet; skipped", "run `wtc build`");
      }
    } catch (e) {
      add("toolchain", false, msg(e));
    }
  }

  // warning, not a failure: it only affects host clients of `wtc tunnel`, and is fixed per command
  const bypass = noProxyLoopback();
  add(
    "no-proxy",
    true,
    bypass.length ? `warn: NO_PROXY/no_proxy has ${bypass.join(", ")}; tunnel clients skip the proxy for localhost` : "no localhost bypass",
    bypass.length ? "clear both for tunnel clients, e.g. `NO_PROXY= no_proxy= curl --socks5-hostname ...`" : undefined,
  );

  add("allowBuilds", true, "info: pnpm 11 blocks dependency build scripts unless allowed via `allowBuilds` in pnpm-workspace.yaml");
  return { checks };
}
