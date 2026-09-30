import { WtcError } from "../errors";
import type { Manifest } from "../setup/schema";

/** Throws PARAM_UNKNOWN for any key in `set` not declared in the manifest. */
export function assertKnownParams(m: Manifest, set: Record<string, string>): void {
  for (const k of Object.keys(set)) {
    if (!(k in m.params)) {
      const known = Object.keys(m.params).join(", ") || "(none)";
      throw new WtcError("PARAM_UNKNOWN", `unknown param ${k}`, `known params: ${known}`);
    }
  }
}

/**
 * Validate `set` against manifest params and apply defaults.
 * Unset optional params without a default are omitted (not injected as env).
 * `pattern` is used as written (`new RegExp(pattern).test(v)`); add ^…$ in the manifest for a full match.
 */
export function resolveParams(m: Manifest, set: Record<string, string>): Record<string, string> {
  assertKnownParams(m, set);
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(m.params)) {
    const v = set[k] ?? p.default;
    if (v === undefined) {
      if (p.required) throw new WtcError("PARAM_REQUIRED", `param ${k} is required`, `pass --set ${k}=<value> (${p.description})`);
      continue;
    }
    if (p.pattern !== undefined && !new RegExp(p.pattern).test(v))
      throw new WtcError("PARAM_INVALID", `param ${k}="${v}" does not match ${p.pattern}`);
    out[k] = v;
  }
  return out;
}

/** Keys explicitly present in `set` whose value differs from the create-time value. */
export function diffParams(created: Record<string, string>, set: Record<string, string>): string[] {
  return Object.keys(set).filter((k) => created[k] !== set[k]);
}
