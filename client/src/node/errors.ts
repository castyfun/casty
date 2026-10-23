import { CastyError } from "../errors.js";

/** The node refused a request or a message. Exit code 3. */
export class NodeError extends CastyError {
  readonly status: number | undefined;
  readonly errCode: string | undefined;

  constructor(message: string, options: { hint?: string; status?: number; errCode?: string } = {}) {
    super(message, 3, options.hint);
    this.status = options.status;
    this.errCode = options.errCode;
  }
}

export class NonceError extends NodeError {}
export class InvalidSignatureError extends NodeError {}
export class InvalidKeyRequestError extends NodeError {}
export class InvalidScopeError extends NodeError {}
export class KeyCapError extends NodeError {}

/** The node accepted a message for relay, but it never showed up as merged. */
export class NotMergedError extends NodeError {}

/** Nothing answered at the node URL. Exit code 4. */
export class NodeUnreachableError extends CastyError {
  constructor(url: string, cause?: unknown) {
    super(
      `cannot reach the node at ${url}`,
      4,
      "start the tunnel with ./scripts/1-node.sh tunnel, or pass --node <url>",
    );
    this.cause = cause;
  }
}

/** Error strings from the gasless signer guide, with what to do about each. */
const KNOWN: [string, typeof NodeError, string][] = [
  [
    "nonce is not greater than stored nonce",
    NonceError,
    "another key change landed first; run the command again to use a fresh nonce",
  ],
  [
    "invalid signature",
    InvalidSignatureError,
    "this seed phrase does not hold the fid's custody address; check --address-index",
  ],
  [
    "invalid signed key request",
    InvalidKeyRequestError,
    "the app fid must be custodied by --app-address-index of the same seed phrase",
  ],
  [
    "invalid scope",
    InvalidScopeError,
    "the app key may not sign this message type; add a key with the scope you need (casty init --scopes)",
  ],
  [
    "active key cap exceeded",
    KeyCapError,
    "the fid holds 1000 active app keys; revoke some with casty key revoke",
  ],
];

/** Maps a non-2xx answer (`{ errCode, details }`) to the most specific NodeError. */
export function nodeErrorFrom(status: number, body: unknown): NodeError {
  const { errCode, details, error, error_detail } = (body ?? {}) as {
    errCode?: unknown;
    details?: unknown;
    error?: unknown;
    error_detail?: unknown;
  };
  // Hubble-style bodies carry errCode and details. Snapchain 0.14 answers a lookup that finds
  // nothing with HTTP 400, `error` and the gRPC status in `error_detail` (seen on a mainnet node).
  const text = [details, error_detail, error].find((v) => typeof v === "string") as
    | string
    | undefined;
  const message = text ?? `the node answered HTTP ${status}`;
  const notFound = status === 404 || /\bNotFound\b/.test(String(error_detail ?? ""));
  const code = typeof errCode === "string" ? errCode : notFound ? "not_found" : undefined;
  const options = { status, ...(code ? { errCode: code } : {}) };
  for (const [text, Kind, hint] of KNOWN) {
    if (message.includes(text)) return new Kind(message, { ...options, hint });
  }
  return new NodeError(message, options);
}
