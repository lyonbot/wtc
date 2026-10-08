import { WtcError } from "../errors";
import { type InstanceContext, summarize } from "../instance/instance";
import { computeImageHash } from "../setup/image-hash";
import { mustExist, noProxyLoopback } from "./common";

/** Socks proxy URLs of an instance plus usage hints (spec §10). */
export async function tunnel(ctx: InstanceContext, name: string) {
  const info = await mustExist(ctx, name);
  const s = await summarize(ctx, name, info, await computeImageHash(ctx.setup));
  if (!s.socks) throw new WtcError("NOT_FOUND", `no socks port recorded for ${name}`, `wtc rm ${name} && wtc up ${name}`);
  const auth = !!ctx.setup.manifest.socksAuth;
  const hints = ["use socks5h:// so DNS resolves inside the container"];
  const bypass = noProxyLoopback();
  if (bypass.length)
    hints.push(`NO_PROXY/no_proxy has ${bypass.join(", ")} — clients will bypass the proxy for localhost; unset both for this client`);
  if (s.socks.bind === "0.0.0.0" && !auth)
    hints.push("proxy is reachable from your LAN without auth; set socksBind or socksAuth to restrict");
  return { urls: s.socks.urls, bind: s.socks.bind, port: s.socks.port, auth, hints };
}
