import { describe, expect, it } from "vitest";
import {
  InvalidKeyRequestError,
  InvalidScopeError,
  InvalidSignatureError,
  KeyCapError,
  NodeError,
  NonceError,
  nodeErrorFrom,
} from "../../src/node/errors.js";

const body = (details: string) => ({ errCode: "bad_request.validation_failure", details });

describe("nodeErrorFrom", () => {
  it.each([
    ["nonce is not greater than stored nonce", NonceError],
    ["invalid signature", InvalidSignatureError],
    ["invalid signed key request", InvalidKeyRequestError],
    ["invalid scope", InvalidScopeError],
    ["active key cap exceeded", KeyCapError],
  ])("maps %j to its own error with a hint and exit code 3", (details, Kind) => {
    const error = nodeErrorFrom(400, body(details));
    expect(error).toBeInstanceOf(Kind);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBeTruthy();
    expect(error.message).toBe(details);
  });

  it("matches a known string inside a longer message", () => {
    expect(nodeErrorFrom(400, body("bad_request: invalid scope for key"))).toBeInstanceOf(
      InvalidScopeError,
    );
  });

  it("keeps unknown errors generic, with the code and status", () => {
    const error = nodeErrorFrom(500, { errCode: "unavailable", details: "busy" });
    expect(error.constructor).toBe(NodeError);
    expect(error.errCode).toBe("unavailable");
    expect(error.status).toBe(500);
  });

  it("copes with a body that is not the node's error JSON", () => {
    expect(nodeErrorFrom(502, undefined).message).toBe("the node answered HTTP 502");
  });
});
