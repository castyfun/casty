import { BadRequest } from "./reply.js";
import type { WireMessage } from "./wire.js";

/** Knobs tests turn through `POST /__mock/control` or `MockNode.control()`. */
export interface Control {
  /** Accepted messages become readable this many ms after submit. */
  mergeDelayMs: number;
  /** Answer the next submit with 200 and never merge it, like a dropped gossip message. */
  dropNextSubmit: boolean;
  /** Fail the next submit with the node's error string for this reason. */
  rejectNextWith: Rejection | undefined;
  /** `blockDelay` reported by successive /v1/info calls; the last value repeats. */
  blockDelay: number[];
  /** Extra latency on every request, so tests can observe concurrency. */
  latencyMs: number;
  /** Answer this many of the next /v1/info calls with 503, like a node that is still starting. */
  infoUnavailable: number;
  /** Answer this many of the next reads (GET /v1/...) with 503, like a node under load. */
  failReads: number;
  /** After the next accepted submit, set `failReads` to this: the write lands, the check fails. */
  failReadsAfterSubmit: number;
  /**
   * Messages to merge as if they had arrived by gossip: no signature or signer is checked, so a
   * test can make any fid cast, react, follow or remove without its key. Applied at once, not kept.
   */
  emitEvents: WireMessage[];
}

/** "unavailable" answers 503, the others 400. */
export type Rejection = "nonce" | "scope" | "signature" | "unavailable";

export const REJECTION_DETAILS: Record<Rejection, string> = {
  nonce: "nonce is not greater than stored nonce",
  scope: "invalid scope",
  signature: "invalid signature",
  unavailable: "the node is too busy to take messages",
};

export function defaultControl(): Control {
  return {
    mergeDelayMs: 0,
    dropNextSubmit: false,
    rejectNextWith: undefined,
    blockDelay: [0],
    latencyMs: 0,
    infoUnavailable: 0,
    failReads: 0,
    failReadsAfterSubmit: 0,
    emitEvents: [],
  };
}

const CHECKS: Record<keyof Control, (v: unknown) => boolean> = {
  mergeDelayMs: (v) => typeof v === "number" && v >= 0,
  dropNextSubmit: (v) => typeof v === "boolean",
  rejectNextWith: (v) => v === undefined || (typeof v === "string" && v in REJECTION_DETAILS),
  blockDelay: (v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number"),
  latencyMs: (v) => typeof v === "number" && v >= 0,
  infoUnavailable: (v) => Number.isInteger(v) && (v as number) >= 0,
  failReads: (v) => Number.isInteger(v) && (v as number) >= 0,
  failReadsAfterSubmit: (v) => Number.isInteger(v) && (v as number) >= 0,
  emitEvents: (v) => Array.isArray(v) && v.every((m) => typeof m === "object" && m !== null),
};

/** Validates a control patch received as JSON. */
export function parseControl(input: unknown): Partial<Control> {
  if (input === null || typeof input !== "object")
    throw new BadRequest("control body must be a JSON object");
  for (const [key, value] of Object.entries(input)) {
    const check = CHECKS[key as keyof Control];
    if (!check) throw new BadRequest(`unknown control key "${key}"`);
    if (!check(value)) throw new BadRequest(`bad value for control key "${key}"`);
  }
  return input as Partial<Control>;
}
