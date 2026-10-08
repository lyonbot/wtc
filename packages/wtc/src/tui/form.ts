import { ID_RE } from "../naming";
import type { Manifest } from "../setup/schema";
import { fit, st } from "./format";
import { editLine, line, renderLine, type Key, type Line } from "./keys";

export interface Field {
  /** "" = the instance name, else the param key */
  key: string;
  label: string;
  hint: string;
  value: Line;
  required: boolean;
  pattern?: string;
  /** the param declares `suggest` */
  suggestible: boolean;
  /** value is an untouched default: the first typed character replaces it, and the dropdown lists every candidate */
  fresh: boolean;
}
export interface FormState {
  fields: Field[];
  focus: number;
  /** candidates per param key, filled lazily by the app */
  suggestions: Record<string, string[]>;
  /** highlighted dropdown row; -1 = none (Tab / Enter then move on instead of completing) */
  hi: number;
  error: string;
}
export type FormResult = { type: "none" } | { type: "cancel" } | { type: "submit"; name: string; set: Record<string, string> } | { type: "focus"; key: string };

export function newForm(m: Pick<Manifest, "params">, name: string): FormState {
  const fields: Field[] = [
    { key: "", label: "name", hint: "lowercase letters, digits, single hyphens", value: line(name), required: true, suggestible: false, fresh: false },
    ...Object.entries(m.params).map(([key, p]) => ({
      key,
      label: key,
      hint: p.description,
      value: line(p.default ?? ""),
      required: !!p.required,
      ...(p.pattern ? { pattern: p.pattern } : {}),
      suggestible: !!p.suggest,
      fresh: p.default !== undefined && p.default !== "",
    })),
  ];
  const focus = name ? 1 : 0;
  return { fields, focus, suggestions: {}, hi: fields[focus]?.fresh ? -1 : 0, error: "" };
}

/** Dropdown rows for the focused field: candidates containing the typed text (all of them while the value is an untouched default), hidden once the text is exactly a candidate. */
export function dropdown(f: FormState): string[] {
  const fl = f.fields[f.focus]!;
  if (!fl.suggestible) return [];
  const all = f.suggestions[fl.key] ?? [];
  const t = fl.fresh ? "" : fl.value.text.toLowerCase();
  if (!fl.fresh && all.includes(fl.value.text)) return [];
  return all.filter((c) => c.toLowerCase().includes(t)).slice(0, 6);
}

const move = (f: FormState, d: number): FormState => {
  const focus = (f.focus + d + f.fields.length) % f.fields.length;
  return { ...f, focus, hi: f.fields[focus]!.fresh ? -1 : 0, error: "" };
};
const setValue = (f: FormState, v: Line): FormState => ({ ...f, fields: f.fields.map((x, i) => (i === f.focus ? { ...x, value: v, fresh: false } : x)), hi: 0, error: "" });

/** First problem with the entered values, as `{ message, focus }`; null when submittable. */
export function validate(f: FormState): { message: string; focus: number } | null {
  for (const [i, fl] of f.fields.entries()) {
    const v = fl.value.text;
    if (fl.key === "" && !ID_RE.test(v)) return { message: "name: lowercase letters, digits and single hyphens (e.g. feat-a)", focus: i };
    if (fl.required && !v) return { message: `${fl.label} is required`, focus: i };
    if (v && fl.pattern && !new RegExp(fl.pattern).test(v)) return { message: `${fl.label} must match ${fl.pattern}`, focus: i };
  }
  return null;
}

/** Handle one key. Returns the new state and what the app should do (submit, cancel, or fetch suggestions for a newly focused field). */
export function formKey(f: FormState, k: Key): [FormState, FormResult] {
  const dd = dropdown(f);
  const open = dd.length > 0 && f.hi >= 0;
  const accept = (): FormState => setValue(f, line(dd[Math.min(f.hi, dd.length - 1)]!));
  const focused = (n: FormState): [FormState, FormResult] => [n, n.fields[n.focus]!.suggestible ? { type: "focus", key: n.fields[n.focus]!.key } : { type: "none" }];
  const submit = (): [FormState, FormResult] => {
    const bad = validate(f);
    if (bad) return [{ ...f, focus: bad.focus, error: bad.message }, { type: "none" }];
    const set: Record<string, string> = {};
    for (const fl of f.fields) if (fl.key && fl.value.text) set[fl.key] = fl.value.text;
    return [f, { type: "submit", name: f.fields[0]!.value.text, set }];
  };
  switch (k.name) {
    case "esc": return [f, { type: "cancel" }];
    case "ctrl-s": return submit();
    case "tab": return open ? [accept(), { type: "none" }] : focused(move(f, 1));
    case "shift-tab": return focused(move(f, -1));
    case "enter":
      if (open) return [accept(), { type: "none" }];
      return f.focus === f.fields.length - 1 ? submit() : focused(move(f, 1));
    case "down": return dd.length ? [{ ...f, hi: Math.min(f.hi + 1, dd.length - 1) }, { type: "none" }] : focused(move(f, 1));
    case "up": return dd.length && f.hi >= 0 ? [{ ...f, hi: f.hi - 1 }, { type: "none" }] : focused(move(f, -1));
    default: {
      const fl = f.fields[f.focus]!;
      // an untouched default is "selected": typing replaces it, deleting clears it
      if (fl.fresh && (k.name === "char" || k.name === "backspace" || k.name === "delete" || k.name === "ctrl-u" || k.name === "ctrl-w"))
        return [setValue(f, line(k.name === "char" ? k.ch! : "")), { type: "none" }];
      const nv = editLine(fl.value, k);
      return [nv ? setValue(f, nv) : f, { type: "none" }];
    }
  }
}

export function renderForm(f: FormState, w: number, h: number): string[] {
  const out = [st.bold("create instance"), ""];
  const lw = Math.max(...f.fields.map((x) => x.label.length));
  for (const [i, fl] of f.fields.entries()) {
    const on = i === f.focus;
    const val = on ? (fl.fresh ? st.inv(fl.value.text) : renderLine(fl.value, st.inv)) : fl.value.text || st.dim("(empty)");
    out.push(`${on ? ">" : " "} ${on ? st.cyan(fl.label.padEnd(lw)) : fl.label.padEnd(lw)}  ${val}`);
    if (on) {
      out.push(`  ${" ".repeat(lw)}  ${st.dim(fl.hint)}`);
      const dd = dropdown(f);
      dd.forEach((c, j) => out.push(`  ${" ".repeat(lw)}  ${j === f.hi ? st.inv(` ${c} `) : ` ${c} `}`));
      if (fl.suggestible && !(f.suggestions[fl.key]?.length) && f.suggestions[fl.key] === undefined) out.push(`  ${" ".repeat(lw)}  ${st.dim("loading suggestions…")}`);
    }
  }
  while (out.length < h - 2) out.push("");
  out.push(f.error ? st.red(f.error) : "");
  out.push(st.dim("Tab/Enter complete or next · ↑↓ move / pick · Ctrl-S create · Esc cancel"));
  return out.map((l) => fit(l, w));
}
