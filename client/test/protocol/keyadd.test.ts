import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeGaslessSignedKeyRequestMetadata,
  KEY_REMOVE_SIGNATURE_TYPE_CUSTODY,
  KEY_REMOVE_SIGNATURE_TYPE_SELF,
  MessageType,
  ViemLocalEip712Signer,
  validations,
  verifyGaslessKeyRequest,
  verifyKeyAdd,
  verifyKeyRemove,
} from "@farcaster/core";
import { hexToBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE_NAMES } from "../../src/config.js";
import { UsageError } from "../../src/errors.js";
import {
  authDeadline,
  buildCustodyRevoke,
  buildKeyAdd,
  buildSelfRevoke,
} from "../../src/protocol/keyadd.js";
import { parseScopes } from "../../src/protocol/scopes.js";
import { fixedSigner, TEST_MNEMONIC } from "../helpers.js";

const FID = 2_000_001_234;
const account = mnemonicToAccount(TEST_MNEMONIC);
const custody = new ViemLocalEip712Signer(account);
const address = hexToBytes(account.address);
const SCOPES = [MessageType.CAST_ADD, MessageType.LINK_ADD];
const DEADLINE = authDeadline();

async function keyAdd(currentUserNonce = 41) {
  const { signer, pubkey } = await fixedSigner();
  const input = {
    fid: FID,
    key: pubkey,
    scopes: SCOPES,
    ttl: 2592000,
    currentUserNonce,
    deadline: DEADLINE,
  };
  const message = await buildKeyAdd(input, custody, signer);
  return { message, body: message.data?.keyAddBody, pubkey };
}

describe("buildKeyAdd", () => {
  it("carries the given scopes, ttl and deadline, and the nonce after currentUserNonce", async () => {
    const { body, pubkey } = await keyAdd(41);
    expect(body?.key).toEqual(pubkey);
    expect(body?.scopes).toEqual(SCOPES);
    expect(body?.ttl).toBe(2592000);
    expect(body?.deadline).toBe(DEADLINE);
    expect(body?.nonce).toBe(42);
  });

  it("is signed by the new key itself, as proof of possession", async () => {
    const { message, pubkey } = await keyAdd();
    expect(message.signer).toEqual(pubkey);
    expect((await validations.validateMessage(message)).isOk()).toBe(true);
  });

  it("carries a custody signature over the gasless KeyAdd domain", async () => {
    const { body, pubkey } = await keyAdd();
    const signed = {
      fid: BigInt(FID),
      key: pubkey,
      keyType: 1,
      scopes: SCOPES,
      ttl: 2592000,
      nonce: 42,
      deadline: BigInt(DEADLINE),
    };
    const ok = await verifyKeyAdd(signed, body?.custodySignature ?? new Uint8Array(), address);
    expect(ok._unsafeUnwrap()).toBe(true);
  });

  it("names the requesting fid in gasless signed key request metadata", async () => {
    const { body, pubkey } = await keyAdd();
    const meta = decodeGaslessSignedKeyRequestMetadata(body?.metadata ?? new Uint8Array());
    const { requestFid, requestSigner, signature, deadline } = meta._unsafeUnwrap();
    expect(requestFid).toBe(BigInt(FID));
    expect(requestSigner.toLowerCase()).toBe(account.address.toLowerCase());
    const ok = await verifyGaslessKeyRequest(
      { requestFid, key: pubkey, deadline },
      signature,
      address,
    );
    expect(ok._unsafeUnwrap()).toBe(true);
  });

  it("lets a separate app fid request the key with its own custody signer", async () => {
    const app = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
    const { signer, pubkey } = await fixedSigner();
    const input = {
      fid: FID,
      key: pubkey,
      scopes: SCOPES,
      ttl: 60,
      currentUserNonce: 0,
      deadline: DEADLINE,
      requestFid: 2_000_000_777,
    };
    const message = await buildKeyAdd(input, custody, signer, new ViemLocalEip712Signer(app));
    const meta = decodeGaslessSignedKeyRequestMetadata(
      message.data?.keyAddBody?.metadata ?? new Uint8Array(),
    );
    expect(meta._unsafeUnwrap().requestFid).toBe(2_000_000_777n);
    expect(meta._unsafeUnwrap().requestSigner.toLowerCase()).toBe(app.address.toLowerCase());
  });
});

describe("revocation", () => {
  it("self-revoke is signed by the stored key and consumes the app nonce", async () => {
    const { signer, pubkey } = await fixedSigner();
    const message = await buildSelfRevoke(
      { fid: FID, requesterNonce: 3, deadline: DEADLINE },
      signer,
    );
    const body = message.data?.keyRemoveBody;
    expect(message.signer).toEqual(pubkey);
    expect(body?.key).toEqual(pubkey);
    expect(body?.signatureType).toBe(KEY_REMOVE_SIGNATURE_TYPE_SELF);
    expect(body?.nonce).toBe(4);
  });

  it("custody revoke carries a KeyRemove signature from the custody address", async () => {
    const { pubkey } = await fixedSigner(9);
    const { signer } = await fixedSigner();
    const input = { fid: FID, key: pubkey, currentUserNonce: 10, deadline: DEADLINE };
    const message = await buildCustodyRevoke(input, custody, signer);
    const body = message.data?.keyRemoveBody;
    expect(body?.signatureType).toBe(KEY_REMOVE_SIGNATURE_TYPE_CUSTODY);
    expect(body?.nonce).toBe(11);
    const signed = { fid: BigInt(FID), key: pubkey, nonce: 11, deadline: BigInt(DEADLINE) };
    const ok = await verifyKeyRemove(signed, body?.signature ?? new Uint8Array(), address);
    expect(ok._unsafeUnwrap()).toBe(true);
  });
});

describe("parseScopes", () => {
  it("defaults to casts, reactions and links, add and remove", () => {
    expect(parseScopes(DEFAULT_SCOPE_NAMES)).toEqual([
      MessageType.CAST_ADD,
      MessageType.CAST_REMOVE,
      MessageType.REACTION_ADD,
      MessageType.REACTION_REMOVE,
      MessageType.LINK_ADD,
      MessageType.LINK_REMOVE,
    ]);
  });

  it("adds USER_DATA_ADD only when user-data is asked for", () => {
    expect(parseScopes("cast,user-data")).toEqual([
      MessageType.CAST_ADD,
      MessageType.CAST_REMOVE,
      MessageType.USER_DATA_ADD,
    ]);
    expect(parseScopes(DEFAULT_SCOPE_NAMES)).not.toContain(MessageType.USER_DATA_ADD);
  });

  it("rejects unknown scope names", () => {
    expect(() => parseScopes("cast,key-add")).toThrow(UsageError);
  });
});

it("never references the onchain getSignedKeyRequestMetadata in src/", () => {
  const src = join(import.meta.dirname, "../../src");
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter((f) =>
    /\bgetSignedKeyRequestMetadata\b/.test(readFileSync(join(src, f), "utf8")),
  );
  expect(offenders).toEqual([]);
});
