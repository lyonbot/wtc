import { renderSummary } from "../cli/render";
import type { UpEvent } from "../instance/instance";
import type { Wtc } from "../wtc";
import { fit } from "./format";
import { line, editLine, type Key, type Line } from "./keys";
import { defaultSel, listItems, renderList, type Row } from "./list";
import { buildMenu, renderMenu, type MenuItem } from "./menu";
import { formKey, newForm, renderForm, type FormState } from "./form";
import type { Term } from "./term";

/** The slice of the facade the TUI uses (tests pass a stub). */
export type TuiApi = Pick<Wtc, "setup" | "ls" | "stats" | "up" | "rm" | "status" | "shell" | "run" | "runHost" | "open" | "suggest">;
export interface TuiDeps {
  w: TuiApi;
  term: Term;
  /** refresh interval of the instance list (default 2000) */
  pollMs?: number;
}
/** Handle for tests: resolves when the app quit; `idle()` resolves when all queued key handling finished. */
export interface TuiHandle {
  done: Promise<void>;
  idle(): Promise<void>;
  /** one poll round (ls + stats) now */
  refresh(): Promise<void>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function runTui(d: TuiDeps): TuiHandle {
  const { w, term } = d;
  const m = w.setup.manifest;
  let screen: "list" | "menu" | "form" | "confirm" | "inspect" = "list";
  let filter: Line = line();
  /** selected instance name; null = the create row; undefined = nothing chosen yet (follow the default) */
  let selName: string | null | undefined;
  let rows: Row[] = [];
  const statsCache: Record<string, { cpu: number; mem: number }> = {};
  const pending = new Map<string, string>(); // instances being created: name -> phase text
  let loaded = false;
  let banner = "";
  let msg = "";
  let menu: { row: Row; items: MenuItem[]; sel: number } | undefined;
  let form: FormState | undefined;
  let confirmName = "";
  let inspect: string[] = [];
  let suspended = false;
  let quit = false;
  const loadingSuggest = new Set<string>();
  let wake: (() => void) | undefined;

  const withStats = (r: Row): Row => {
    const { cpu: _c, mem: _m, ...rest } = r;
    const s = statsCache[r.name];
    return s ? { ...rest, cpu: s.cpu, mem: s.mem } : rest;
  };
  const items = () => listItems(rows, filter.text);
  const selIndex = () => {
    const its = items();
    const i = its.findIndex((it) => (it.kind === "create" ? selName === null : it.row.name === selName));
    return i >= 0 ? i : defaultSel(its);
  };
  const select = (i: number) => {
    const its = items();
    const it = its[Math.max(0, Math.min(its.length - 1, i))]!;
    selName = it.kind === "create" ? null : it.row.name;
  };

  function render() {
    if (suspended || quit) return;
    const { cols, rows: h } = term.size();
    let lines: string[];
    if (screen === "menu" && menu) lines = renderMenu(menu.row.name, menu.items, menu.sel, cols, h, msg);
    else if (screen === "form" && form) lines = renderForm(form, cols, h);
    else if (screen === "confirm") lines = [`delete ${confirmName}?`, "", "removes the container, its volumes and state.", "", "[y] delete   [any other key] cancel"].map((l) => fit(l, cols));
    else if (screen === "inspect") lines = [...inspect, "", "press any key"].map((l) => fit(l, cols));
    else lines = renderList({ setupId: m.id, rows, filter, sel: selIndex(), msg, loaded, ...(banner ? { banner } : {}) }, cols, h);
    while (lines.length < h) lines.push("");
    term.write("\x1b[H" + lines.slice(0, h).join("\x1b[K\r\n") + "\x1b[K");
  }

  // ---- polling -------------------------------------------------------------------------------------------------
  async function poll() {
    try {
      const list = await w.ls();
      banner = "";
      const seen = new Set(list.map((s) => s.name));
      for (const n of seen) pending.delete(n);
      rows = [
        ...list.map((s): Row => ({ name: s.name, state: s.state, phase: s.phase, ...(s.message ? { message: s.message } : {}), staleImage: s.staleImage })).map(withStats),
        ...[...pending].filter(([n]) => !seen.has(n)).map(([name, phase]): Row => ({ name, state: "booting", phase })),
      ].sort((a, b) => (a.name < b.name ? -1 : 1));
      loaded = true;
      render();
      const live = rows.filter((r) => r.state === "ready" || r.state === "booting").map((r) => r.name);
      const st = await w.stats(live);
      for (const k of Object.keys(statsCache)) delete statsCache[k];
      for (const [n, s] of Object.entries(st)) statsCache[n] = { cpu: s.cpuPercent, mem: s.memBytes };
      rows = rows.map(withStats);
      render();
    } catch (e) {
      banner = `docker unavailable: ${errText(e)}`;
      loaded = true;
      render();
    }
  }
  const loop = (async () => {
    while (!quit) {
      await poll();
      await new Promise<void>((res) => {
        const t = setTimeout(res, d.pollMs ?? 2000);
        wake = () => (clearTimeout(t), res());
      });
    }
  })();

  // ---- actions -------------------------------------------------------------------------------------------------
  const bg = (p: Promise<unknown>) => void p.catch((e) => ((msg = errText(e)), render()));

  /** Run something that owns the terminal (shell, script). `pause` keeps its output on screen until a key is pressed (always for scripts; for a shell only when it failed). */
  async function external(fn: () => Promise<number>, pause = false) {
    term.suspend();
    suspended = true;
    let code: number;
    try {
      code = await fn();
    } catch (e) {
      term.write(`\r\n${errText(e)}\r\n`);
      code = 1;
    }
    if (pause || code !== 0) {
      term.write(`\r\n[${code === 0 ? "done" : `exit ${code}`}] press any key to return `);
      await term.waitKey();
      term.write("\r\n"); // the cursor is still on the prompt line of the normal screen: the next command must start on a fresh line
    }
    suspended = false;
    term.resume();
    msg = code === 0 ? "" : `exit ${code}`;
    wake?.();
  }

  async function choose(it: MenuItem, row: Row) {
    const a = it.action;
    screen = "list";
    if (a.type === "shell") await external(() => w.shell(row.name));
    else if (a.type === "script") {
      await external(() => (a.where === "host" ? w.runHost(row.name, a.script, []) : w.run(row.name, a.script, [])), true);
      screen = "menu"; // back to the instance's menu, so the next action is one key away
    }
    else if (a.type === "open") {
      try {
        const r = await w.open(row.name, a.editor);
        msg = r.launched ? `opened ${row.name} in ${a.editor}` : `${a.editor} not in PATH`;
      } catch (e) {
        msg = errText(e);
      }
    } else if (a.type === "inspect") {
      try {
        inspect = renderSummary(await w.status(row.name)).split("\n");
        screen = "inspect";
      } catch (e) {
        msg = errText(e);
      }
    } else {
      confirmName = row.name;
      screen = "confirm";
    }
  }

  function startCreate(name: string, set: Record<string, string>) {
    pending.set(name, "starting");
    selName = name;
    msg = `creating ${name}…`;
    bg(
      (async () => {
        try {
          for await (const e of w.up(name, { set }) as AsyncIterable<UpEvent>) {
            if (e.type === "action") pending.set(name, e.action);
            else if (e.type === "status" && e.summary.phase) pending.set(name, e.summary.phase);
            else if (e.type === "done") msg = e.summary.state === "failed" ? `${name} failed (${e.summary.message ?? e.summary.phase ?? "see wtc logs"})` : `${name} ready`;
            wake?.();
          }
        } catch (e) {
          msg = `create ${name}: ${errText(e)}`;
        } finally {
          pending.delete(name);
          wake?.();
          render();
        }
      })(),
    );
  }

  function fetchSuggest() {
    const f = form;
    const fl = f?.fields[f.focus];
    if (!f || !fl?.suggestible || f.suggestions[fl.key] !== undefined || loadingSuggest.has(fl.key)) return;
    loadingSuggest.add(fl.key);
    const others = Object.fromEntries(f.fields.filter((x) => x.key && x.key !== fl.key).map((x) => [x.key, x.value.text]));
    bg(
      w.suggest(fl.key, "", others).then((list) => {
        loadingSuggest.delete(fl.key);
        if (form) form = { ...form, suggestions: { ...form.suggestions, [fl.key]: list } };
        render();
      }),
    );
  }

  // ---- keys ----------------------------------------------------------------------------------------------------
  async function onKey(k: Key) {
    if (k.name === "ctrl-c") return void (await stop());
    if (screen === "inspect") screen = "list";
    else if (screen === "confirm") {
      screen = "list";
      if (k.name === "char" && k.ch === "y") {
        const n = confirmName;
        msg = `removing ${n}…`;
        bg(w.rm(n, { force: false }).then(() => ((msg = `removed ${n}`), wake?.()), (e) => ((msg = errText(e)), render())));
      }
    } else if (screen === "menu" && menu) {
      const mu = menu;
      if (k.name === "esc") screen = "list";
      else if (k.name === "up") mu.sel = Math.max(0, mu.sel - 1);
      else if (k.name === "down") mu.sel = Math.min(mu.items.length - 1, mu.sel + 1);
      else if (k.name === "enter") await choose(mu.items[mu.sel]!, mu.row);
      else if (k.name === "char") {
        const it = mu.items.find((x) => x.key === k.ch);
        if (it) await choose(it, mu.row);
      }
    } else if (screen === "form" && form) {
      const [nf, res] = formKey(form, k);
      form = nf;
      if (res.type === "cancel") screen = "list";
      else if (res.type === "submit") {
        screen = "list";
        startCreate(res.name, res.set);
      } else if (res.type === "focus") fetchSuggest();
    } else {
      msg = "";
      const its = items();
      if (k.name === "esc") {
        if (filter.text) filter = line();
        else return void (await stop());
      } else if (k.name === "up") select(selIndex() - 1);
      else if (k.name === "down") select(selIndex() + 1);
      else if (k.name === "enter") {
        const it = its[selIndex()]!;
        if (it.kind === "create") {
          form = newForm(m, it.name);
          screen = "form";
          fetchSuggest();
        } else {
          menu = { row: it.row, items: buildMenu(m, it.row), sel: 0 };
          screen = "menu";
        }
      } else {
        const nl = editLine(filter, k);
        if (nl && nl.text !== filter.text) {
          filter = nl;
          const its2 = items();
          select(defaultSel(its2));
        } else if (nl) filter = nl;
      }
    }
    render();
  }

  let chain: Promise<void> = Promise.resolve();
  term.onKey((k) => void (chain = chain.then(() => onKey(k)).catch((e) => ((msg = errText(e)), render()))));
  term.onResize(render);

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  async function stop() {
    if (quit) return;
    quit = true;
    wake?.();
    term.close();
    resolveDone();
  }
  render();
  return { done, idle: async () => { await chain; }, refresh: poll };
}
