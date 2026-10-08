import { describe, expect, test } from "bun:test";
import type { InstanceSummary, UpEvent } from "../../src/instance/instance";
import { runTui, type TuiApi } from "../../src/tui/app";
import { parseKeys, type Key } from "../../src/tui/keys";
import type { Term } from "../../src/tui/term";
import { manifestSchema, type Manifest } from "../../src/setup/schema";

class FakeTerm implements Term {
  frames: string[] = [];
  events: string[] = [];
  private cb?: (k: Key) => void;
  size = () => ({ cols: 90, rows: 16 });
  write(s: string) { this.frames.push(s); }
  onKey(cb: (k: Key) => void) { this.cb = cb; }
  onResize() {}
  suspend() { this.events.push("suspend"); }
  resume() { this.events.push("resume"); }
  async waitKey() { this.events.push("waitKey"); }
  close() { this.events.push("close"); }
  press(s: string) { for (const k of parseKeys(s)) this.cb!(k); }
  /** the last full frame as plain text lines */
  get screen(): string[] {
    const f = [...this.frames].reverse().find((x) => x.startsWith("\x1b[H")) ?? "";
    return f.slice(3).split("\x1b[K\r\n").map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
  }
  get text() { return this.screen.join("\n"); }
}

const sum = (name: string, state: InstanceSummary["state"], phase: string | null = null): InstanceSummary => ({ name, container: `wtc-demo--${name}`, state, phase, staleImage: false });

function setup() {
  const manifest = manifestSchema.parse({
    id: "demo",
    params: { BRANCH: { description: "branch", default: "master", suggest: () => ["master", "feat/flow"] } },
    scripts: { "restart-dev-server": { run: "x", description: "restart" } },
    hostScripts: { chrome: { run: "./chrome.sh", description: "open chrome" } },
  }) as Manifest;
  const calls: [string, ...unknown[]][] = [];
  let list = [sum("alpha", "ready", "wait-ready"), sum("beta", "stopped")];
  const api: TuiApi = {
    setup: { dir: "/tmp/x", manifest },
    ls: async () => list,
    stats: async (names) => Object.fromEntries(names.map((n) => [n, { cpuPercent: 12.5, memBytes: 300 * 1024 ** 2, memLimitBytes: 0 }])),
    async *up(name: string, o?: { set?: Record<string, string> }) {
      calls.push(["up", name, o?.set]);
      list = [...list, sum(name, "booting", "install")];
      yield { type: "done", summary: sum(name, "ready") } as UpEvent;
    },
    rm: async (n) => void calls.push(["rm", n]),
    status: async (n) => sum(n, "ready", "wait-ready"),
    shell: async (n) => (calls.push(["shell", n]), 0),
    run: async (n, s) => (calls.push(["run", n, s]), 0),
    runHost: async (n, s) => (calls.push(["runHost", n, s]), 3),
    open: async (n, e) => (calls.push(["open", n, e]), { uri: "u", launched: true }),
    suggest: async (k) => (calls.push(["suggest", k]), ["master", "feat/flow"]),
  };
  const term = new FakeTerm();
  const h = runTui({ w: api, term, pollMs: 60_000 });
  const send = async (s: string) => (term.press(s), await h.idle());
  return { h, term, send, calls };
}

describe("tui app", () => {
  test("first screen: counts, state, cpu and memory; create row is last", async () => {
    const { h, term } = setup();
    await h.refresh();
    expect(term.text).toContain("2 instances · 1 ready");
    expect(term.text).toMatch(/alpha\s+ready\s+wait-ready\s+13%\s+300M/);
    expect(term.text).toMatch(/beta\s+stopped/);
    const lines = term.screen.filter((l) => l.includes("create"));
    expect(lines).toEqual(["  + create…"]);
  });

  test("filter focused by default; unmatched text becomes the new name and opens the form", async () => {
    const { h, term, send, calls } = setup();
    await h.refresh();
    await send("zz-new");
    expect(term.text).toContain('> + create "zz-new"');
    await send("\r");
    expect(term.text).toContain("create instance");
    expect(term.text).toMatch(/name\s+zz-new/);
    // BRANCH is focused -> suggestions are fetched and shown
    await Bun.sleep(5);
    expect(calls).toContainEqual(["suggest", "BRANCH"]);
    await send("\x15feat"); // clear field, type
    expect(term.text).toContain("feat/flow");
    await send("\t"); // complete
    await send("\x13"); // ctrl-s submit
    expect(calls).toContainEqual(["up", "zz-new", { BRANCH: "feat/flow" }]);
    await Bun.sleep(5);
    await h.refresh();
    expect(term.text).toContain("zz-new");
  });

  test("Enter opens the menu; host script shortcut runs on host and a non-zero exit waits for Enter", async () => {
    const { h, term, send, calls } = setup();
    await h.refresh();
    await send("alp");
    await send("\r");
    expect(term.text).toContain("[h] $ chrome");
    expect(term.text).toMatch(/\[[a-z]\] # restart-dev-server/);
    await send("h");
    expect(calls).toContainEqual(["runHost", "alpha", "chrome"]);
    expect(term.events).toEqual(["suspend", "waitKey", "resume"]); // output stays until a key is pressed
    expect(term.text).toContain("exit 3");
    expect(term.text).toContain("[h] $ chrome"); // back on the instance's menu
    await send("\x1b");
    expect(term.text).toContain("2 instances"); // Esc -> list
  });

  test("a script that succeeds also waits for a key before returning to the menu", async () => {
    const { h, term, send, calls } = setup();
    await h.refresh();
    await send("\r");
    await send("r"); // `#` restart-dev-server (shortcut = first free letter of its name)
    expect(calls).toContainEqual(["run", "alpha", "restart-dev-server"]);
    expect(term.events).toEqual(["suspend", "waitKey", "resume"]);
    expect(term.frames).toContain("\r\n"); // fresh line after the pause, so the next script's output does not continue the prompt
    expect(term.text).toContain("restart-dev-server");
  });

  test("shell hands the whole terminal over and returns to the list", async () => {
    const { h, term, send, calls } = setup();
    await h.refresh();
    await send("\r");
    await send("s");
    expect(calls).toContainEqual(["shell", "alpha"]);
    expect(term.events).toEqual(["suspend", "resume"]);
    expect(term.text).toContain("2 instances");
  });

  test("delete asks for confirmation; any key but y cancels", async () => {
    const { h, term, send, calls } = setup();
    await h.refresh();
    await send("\rd");
    expect(term.text).toContain("delete alpha?");
    await send("n");
    expect(calls.find((c) => c[0] === "rm")).toBeUndefined();
    await send("\rd");
    await send("y");
    expect(calls).toContainEqual(["rm", "alpha"]);
  });

  test("Esc clears the filter first, then quits and restores the terminal; Ctrl-C always quits", async () => {
    const a = setup();
    await a.h.refresh();
    await a.send("al");
    await a.send("\x1b");
    expect(a.term.text).toMatch(/filter\s*$/m);
    expect(a.term.events).not.toContain("close");
    await a.send("\x1b");
    await a.h.done;
    expect(a.term.events).toContain("close");
    const b = setup();
    await b.send("\x03");
    await b.h.done;
    expect(b.term.events).toContain("close");
  });

  test("docker down shows a banner instead of crashing", async () => {
    const term = new FakeTerm();
    const manifest = manifestSchema.parse({ id: "demo" }) as Manifest;
    const w = { setup: { dir: "/x", manifest }, ls: async () => { throw new Error("Cannot connect to the Docker daemon"); }, stats: async () => ({}) } as unknown as TuiApi;
    const h = runTui({ w, term, pollMs: 60_000 });
    await h.refresh();
    expect(term.text).toContain("docker unavailable: Cannot connect to the Docker daemon");
    expect(term.text).toContain("+ create…"); // still usable
  });
});
