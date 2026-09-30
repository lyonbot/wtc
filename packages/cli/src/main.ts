#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import * as lib from "@wtc/lib";
import { createWtc, FakeRuntime, resolveSetupDir, WtcError, WTC_VERSION, type Wtc } from "@wtc/lib";
import skillMd from "../skill/SKILL.md" with { type: "text" };
import { renderLs, renderSummary, table, upRenderer } from "./render";

/** Virtual modules so a user's wtc.setup.ts can `import { defineSetup } from "wtc"` (also in the compiled binary). */
Bun.plugin({
  name: "wtc-virtual",
  setup(b) {
    for (const id of ["wtc", "@wtc/lib"]) b.module(id, () => ({ exports: { ...lib }, loader: "object" }));
  },
});

/** Bad CLI input detected inside an action; exits 2. */
class UsageError extends Error {}

type Loader = (setupFlag: string | undefined) => Promise<Wtc>;
const defaultLoader: Loader = (flag) =>
  createWtc({
    setupDir: resolveSetupDir({ flag, env: process.env.WTC_SETUP, cwd: process.cwd() }),
    ...(process.env.WTC_FAKE_RUNTIME === "1" ? { runtime: new FakeRuntime() } : {}),
  });
let loader: Loader = defaultLoader;
let exitCode = 0;

const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const load = (cmd: Command) => loader(cmd.optsWithGlobals<{ setup?: string }>().setup);

/** Wrap an action: load the setup, run, map WtcError to exit 1. */
const act = <A extends unknown[]>(fn: (w: Wtc, cmd: Command, ...a: A) => Promise<void | number>) =>
  async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const rest = args.slice(0, -1) as unknown as A;
    const code = await fn(await load(cmd), cmd, ...rest);
    if (typeof code === "number") exitCode = code;
  };

const collect = (v: string, prev: string[]) => [...prev, v];

export function buildProgram(): Command {
  const p = new Command("wtc")
    .description("one docker container per git worktree")
    .version(WTC_VERSION)
    .option("--setup <dir>", "setup directory (default: $WTC_SETUP, else search upwards for wtc.setup.ts)")
    .showHelpAfterError()
    .exitOverride();
  const jopt = "print JSON";

  p.command("build").description("build the image (skipped if unchanged)").option("--json", jopt)
    .action(act(async (w, cmd) => {
      const r = await w.build({ onLog: (l) => process.stderr.write(l.endsWith("\n") ? l : l + "\n") });
      if (cmd.opts().json) json(r); else console.log(r.skipped ? `image up to date: ${r.ref}` : `built ${r.ref}`);
    }));

  p.command("up <name>").description("create / start / wait for an instance")
    .option("--set <K=V>", "instance parameter (repeatable)", collect, [] as string[])
    .option("--socks-bind <addr>", "socks bind address (creation only)")
    .option("--socks-host-port <port>", "fixed host port for socks (creation only)")
    .option("--no-wait", "return without waiting for ready")
    .option("--json", "print events as newline-delimited JSON")
    .action(act(async (w, cmd, name: string) => {
      const o = cmd.opts();
      const set: Record<string, string> = {};
      for (const kv of o.set as string[]) {
        const i = kv.indexOf("=");
        if (i < 1) throw new UsageError(`--set expects K=V, got "${kv}"`);
        set[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const render = upRenderer(name);
      let failed = false;
      for await (const e of w.up(name, {
        set, wait: o.wait,
        ...(o.socksBind ? { socksBind: o.socksBind } : {}),
        ...(o.socksHostPort ? { socksHostPort: Number(o.socksHostPort) } : {}),
      })) {
        if (o.json) console.log(JSON.stringify(e));
        else for (const l of render(e)) console.log(l);
        if (e.type === "done" && e.summary.state === "failed") failed = true;
      }
      return failed ? 1 : 0;
    }));

  for (const [c, d] of [["start", "start a stopped instance"], ["stop", "stop (keeps overlay)"], ["restart", "re-run init.sh"]] as const)
    p.command(`${c} <name>`).description(d).action(act(async (w, _c, name: string) => { await w[c](name); console.log(`${c === "stop" ? "stopped" : c === "start" ? "started" : "restarting"} ${name}`); }));

  p.command("rm <name>").description("run preRemove, delete container, volumes and state").option("--force", "skip preRemove / any state")
    .action(act(async (w, cmd, name: string) => { await w.rm(name, { force: !!cmd.opts().force }); console.log(`removed ${name}`); }));

  p.command("ls").description("list instances").option("--json", jopt)
    .action(act(async (w, cmd) => {
      const l = await w.ls();
      if (cmd.opts().json) json(l); else console.log(renderLs(l));
    }));

  p.command("status <name>").description("show instance status").option("--watch", "follow changes until Ctrl-C").option("--json", jopt)
    .action(act(async (w, cmd, name: string) => {
      const o = cmd.opts();
      const show = (s: Parameters<typeof renderSummary>[0]) => (o.json ? json(s) : console.log(renderSummary(s) + (o.watch ? "\n" : "")));
      if (!o.watch) return show(await w.status(name));
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      for await (const s of w.watch(name, ac.signal)) show(s);
    }));

  p.command("logs <name>").description("print init logs").option("-f, --follow", "follow until Ctrl-C").option("--boot <id>", "boot id (default: current)")
    .action(act(async (w, cmd, name: string) => {
      const o = cmd.opts();
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      for await (const l of w.logs(name, { follow: !!o.follow, ...(o.boot ? { boot: o.boot } : {}), signal: ac.signal }))
        process.stdout.write(l.endsWith("\n") ? l : l + "\n");
    }));

  p.command("run <name> <script> [args...]").description("run a manifest script in the container (args after --)")
    .allowUnknownOption()
    .action(act(async (w, _c, name: string, script: string, args: string[]) => w.run(name, script, args ?? [])));

  p.command("check <name>").description("run health checks now").option("--json", jopt)
    .action(act(async (w, cmd, name: string) => {
      const r = await w.check(name);
      if (cmd.opts().json) json(r);
      else {
        for (const i of r.items) {
          console.log(`${i.ok ? "✔" : "✖"} ${i.name} (${i.durationMs}ms)`);
          if (!i.ok && i.output) console.log(i.output.split("\n").map((l) => `  | ${l}`).join("\n"));
        }
        console.log(`health: ${r.health}`);
      }
      return r.health === "unhealthy" ? 1 : 0;
    }));

  p.command("shell <name>").description("interactive shell in the container").action(act(async (w, _c, name: string) => w.shell(name)));

  p.command("tunnel <name>").description("print socks proxy URLs").option("--json", jopt)
    .action(act(async (w, cmd, name: string) => {
      const t = await w.tunnel(name);
      if (cmd.opts().json) return void json(t);
      for (const u of t.urls) console.log(u);
      for (const h of t.hints) console.log(`hint: ${h}`);
    }));

  p.command("open <name> [editor]").description("open in VS Code / Cursor (editor: code | cursor)").option("--json", jopt)
    .action(act(async (w, cmd, name: string, editor?: string) => {
      if (editor && editor !== "code" && editor !== "cursor") throw new UsageError("editor must be code or cursor");
      const r = await w.open(name, editor as "code" | "cursor" | undefined);
      if (cmd.opts().json) json(r); else console.log(r.launched ? `opened ${r.uri}` : `editor not in PATH; URI: ${r.uri}`);
    }));

  p.command("gc").description("remove orphaned state").option("--dry-run", "only report").option("--prune-store", "also prune the pnpm store").option("--json", jopt)
    .action(act(async (w, cmd) => {
      const o = cmd.opts();
      const r = await w.gc({ dryRun: !!o.dryRun, pruneStore: !!o.pruneStore });
      if (o.json) return void json(r);
      for (const i of r.removed) console.log(`${o.dryRun ? "would remove" : "removed"} ${i.kind} ${i.name}`);
      if (!r.removed.length) console.log("nothing to clean");
    }));

  p.command("doctor").description("check runtime and environment").option("--json", jopt)
    .action(act(async (w, cmd) => {
      const r = await w.doctor();
      if (cmd.opts().json) json(r);
      else {
        console.log(table(r.checks.map((c) => [c.ok ? "✔" : "✖", c.name, c.detail])));
        for (const c of r.checks) if (!c.ok && c.hint) console.log(`hint (${c.name}): ${c.hint}`);
      }
      return r.checks.every((c) => c.ok) ? 0 : 1;
    }));

  // `skill` and `--help`/`--version` need no setup: bypass load().
  p.command("skill").description("print the agent usage guide (SKILL.md)").option("--llms", "strip YAML frontmatter")
    .action((o: { llms?: boolean }) => {
      process.stdout.write(o.llms ? skillMd.replace(/^---\n[\s\S]*?\n---\n+/, "") : skillMd);
    });
  return p;
}

/** Run the CLI; returns the exit code. `load` is injectable for tests. */
export async function runCli(argv: string[], load?: Loader): Promise<number> {
  loader = load ?? defaultLoader;
  exitCode = 0;
  try {
    await buildProgram().parseAsync(argv);
    return exitCode;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof WtcError && e.hint) console.error(`hint: ${e.hint}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await runCli(process.argv));
