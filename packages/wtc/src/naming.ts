import { WtcError } from "./errors";

export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertId(kind: "setupId" | "name" | "volume", v: string): void {
  if (!ID_RE.test(v)) {
    throw new WtcError(
      "INVALID_ID",
      `invalid ${kind} "${v}"`,
      "use lowercase letters, digits and single hyphens (e.g. feat-a)",
    );
  }
}

export const containerName = (setupId: string, name: string) => `wtc-${setupId}--${name}`;
export const imageRepo = (setupId: string) => `wtc-${setupId}`;
export const imageRef = (setupId: string, hash: string) => `${imageRepo(setupId)}:${hash}`;
export const pnpmVolume = (setupId: string) => `wtc-${setupId}.pnpm`;
export const setupVolume = (setupId: string, vol: string) => `wtc-${setupId}.v.${vol}`;
export const instanceVolume = (setupId: string, name: string, vol: string) =>
  `${containerName(setupId, name)}.v.${vol}`;

export const LABEL = {
  setup: "wtc.setup",
  setupDir: "wtc.setupDir",
  name: "wtc.name",
  protocol: "wtc.protocol",
  socksHostPort: "wtc.socksHostPort",
  scope: "wtc.scope",
} as const;

/** Prefix of the labels carrying `container.annotations` (`wtc.ann.<key>`). */
export const ANNOTATION_LABEL_PREFIX = "wtc.ann.";
