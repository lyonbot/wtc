import { open, readdir, stat } from "node:fs/promises";
import { WtcError } from "../errors";
import { instancePaths } from "../instance/create-spec";
import type { InstanceContext } from "../instance/instance";
import { assertId } from "../naming";

/** Init log lines of one boot (latest by default). `follow` tails the file until `signal` aborts. */
export async function* logs(
  ctx: InstanceContext,
  name: string,
  o: { follow?: boolean; boot?: string; signal?: AbortSignal } = {},
): AsyncIterable<string> {
  assertId("name", name);
  const dir = instancePaths(ctx.setup.dir, name).log;
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^init\..+\.log$/.test(f)).sort();
  const file = o.boot ? `init.${o.boot}.log` : files[files.length - 1];
  if (!file || !files.includes(file))
    throw new WtcError("NOT_FOUND", o.boot ? `no log for boot ${o.boot}` : `no logs for ${name}`, files.length ? `boots: ${files.map((f) => f.slice(5, -4)).join(", ")}` : undefined);
  const path = `${dir}/${file}`;

  let offset = 0;
  let partial = "";
  for (;;) {
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > offset) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = size;
        partial += buf.toString("utf8");
      } finally {
        await fh.close();
      }
      const lines = partial.split("\n");
      partial = lines.pop()!;
      yield* lines;
    }
    if (!o.follow || o.signal?.aborted) break;
    await new Promise<void>((res) => {
      const t = setTimeout(done, ctx.pollMs ?? 250);
      function done() { clearTimeout(t); o.signal?.removeEventListener("abort", done); res(); }
      o.signal?.addEventListener("abort", done, { once: true });
    });
  }
  if (partial) yield partial;
}
