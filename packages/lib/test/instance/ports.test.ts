import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { allocateSocksPort } from "../../src/instance/ports";
import { FakeRuntime } from "../../src/runtime/fake";
import type { CreateSpec } from "../../src/runtime/types";

const spec = (name: string, labels: Record<string, string>): CreateSpec => ({
  name, image: "i", labels, env: {}, mounts: [], ports: [], entrypoint: [], extraHosts: [],
});
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function freeBase(): Promise<number> {
  // pick a random high base; tests only need a few consecutive ports
  return 40000 + Math.floor(Math.random() * 20000);
}

describe("allocateSocksPort", () => {
  test("skips ports in wtc labels (any setup) and in exclude", async () => {
    const rt = new FakeRuntime();
    const b = await freeBase();
    await rt.create(spec("a", { "wtc.setup": "x", "wtc.socksHostPort": String(b) }));
    await rt.create(spec("b", { "wtc.setup": "other", "wtc.socksHostPort": String(b + 1) }));
    expect(await allocateSocksPort(rt, [b, b + 10], new Set([b + 2]))).toBe(b + 3);
  });
  test("skips ports with a host listener", async () => {
    const rt = new FakeRuntime();
    const b = await freeBase();
    const s = createServer();
    await new Promise<void>((r) => s.listen(b, "0.0.0.0", r));
    servers.push(s);
    expect(await allocateSocksPort(rt, [b, b + 10], new Set())).toBe(b + 1);
  });
  test("NO_FREE_PORT when range exhausted", async () => {
    const rt = new FakeRuntime();
    const b = await freeBase();
    const e = await allocateSocksPort(rt, [b, b + 1], new Set([b, b + 1])).catch((x) => x);
    expect(e.code).toBe("NO_FREE_PORT");
  });
});
