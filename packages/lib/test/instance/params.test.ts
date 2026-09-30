import { describe, expect, test } from "bun:test";
import { diffParams, resolveParams } from "../../src/instance/params";
import { manifest } from "./helpers";

const m = manifest({
  params: {
    BRANCH: { description: "b", default: "main" },
    TICKET: { description: "t", required: true, pattern: "^[A-Z]+-\\d+$" },
    OPT: { description: "o" },
  },
});
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as { code: string }).code; } };

describe("resolveParams", () => {
  test("applies defaults, keeps explicit, omits unset optional", () => {
    expect(resolveParams(m, { TICKET: "AB-1" })).toEqual({ BRANCH: "main", TICKET: "AB-1" });
    expect(resolveParams(m, { TICKET: "AB-1", BRANCH: "dev", OPT: "x" })).toEqual({ BRANCH: "dev", TICKET: "AB-1", OPT: "x" });
  });
  test("missing required -> PARAM_REQUIRED", () => expect(code(() => resolveParams(m, {}))).toBe("PARAM_REQUIRED"));
  test("pattern mismatch -> PARAM_INVALID", () => expect(code(() => resolveParams(m, { TICKET: "nope" }))).toBe("PARAM_INVALID"));
  test("unknown key -> PARAM_UNKNOWN", () => expect(code(() => resolveParams(m, { TICKET: "A-1", NOPE: "1" }))).toBe("PARAM_UNKNOWN"));
});

describe("diffParams", () => {
  test("only explicit keys whose value differs", () => {
    const created = { BRANCH: "main", TICKET: "AB-1" };
    expect(diffParams(created, {})).toEqual([]);
    expect(diffParams(created, { BRANCH: "main" })).toEqual([]);
    expect(diffParams(created, { BRANCH: "dev", TICKET: "AB-1" })).toEqual(["BRANCH"]);
    expect(diffParams(created, { OPT: "x" })).toEqual(["OPT"]);
  });
});
