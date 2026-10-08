import { describe, expect, test } from "bun:test";
import {
  assertId, containerName, imageRef, imageRepo, instanceVolume, LABEL, pnpmVolume, setupVolume,
} from "../src/naming";
import { WtcError } from "../src/errors";
import { PROTOCOL_VERSION, WTC_VERSION } from "../src/version";

describe("naming", () => {
  test("name functions", () => {
    expect(containerName("basic", "feat-a")).toBe("wtc-basic--feat-a");
    expect(imageRepo("basic")).toBe("wtc-basic");
    expect(imageRef("basic", "abc123")).toBe("wtc-basic:abc123");
    expect(pnpmVolume("basic")).toBe("wtc-basic.pnpm");
    expect(setupVolume("basic", "m2")).toBe("wtc-basic.v.m2");
    expect(instanceVolume("basic", "feat-a", "m2")).toBe("wtc-basic--feat-a.v.m2");
  });
  test("labels and versions", () => {
    expect(LABEL.setup).toBe("wtc.setup");
    expect(LABEL.scope).toBe("wtc.scope");
    expect(WTC_VERSION).toBe("0.1.1");
    expect(PROTOCOL_VERSION).toBe(1);
  });
  test("assertId rejects bad ids", () => {
    for (const bad of ["a--b", "A", "a.b", "a_b", "-a", "a-", ""]) {
      try {
        assertId("name", bad);
        throw new Error("did not throw for " + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(WtcError);
        expect((e as WtcError).code).toBe("INVALID_ID");
      }
    }
  });
  test("assertId accepts good ids", () => {
    expect(() => assertId("name", "feat-a")).not.toThrow();
    expect(() => assertId("setupId", "x1")).not.toThrow();
  });
});
