import { WtcError } from "../errors";
import type { LoadedSetup } from "../setup/load";

/** the form filters locally and shows only a few rows, so keep big branch lists whole */
const MAX = 20_000;
const TIMEOUT_MS = 8000;

/**
 * Completion candidates for param `key` (see `ParamSuggest`). Never throws for a failing or slow `suggest`:
 * that yields []. An unknown param or one without `suggest` is a usage error.
 */
export async function suggest(setup: LoadedSetup, key: string, input: string, params: Record<string, string> = {}): Promise<string[]> {
  const p = setup.manifest.params[key];
  if (!p) throw new WtcError("PARAM_UNKNOWN", `unknown param ${key}`);
  if (!p.suggest) return [];
  try {
    const all = await Promise.race([
      Promise.resolve(p.suggest(input, { setupDir: setup.dir, params })),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("suggest timed out")), TIMEOUT_MS).unref?.()),
    ]);
    return [...new Set(all.filter((x) => typeof x === "string" && x))].slice(0, MAX);
  } catch {
    return [];
  }
}
