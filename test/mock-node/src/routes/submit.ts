import {
  ADMISSIBLE_KEY_ADD_SCOPES,
  decodeGaslessSignedKeyRequestMetadata,
  KEY_REMOVE_SIGNATURE_TYPE_SELF,
  MAX_GASLESS_KEYS_PER_FID,
  Message,
  type MessageData,
  MessageType,
  validations,
  verifyGaslessKeyRequest,
  verifyKeyAdd,
  verifyKeyRemove,
} from "@farcaster/core";
import { hexToBytes } from "viem";
import { REJECTION_DETAILS } from "../control.js";
import { nodeError, ok, type Reply, rejected } from "../reply.js";
import { activeSigner, custodyOf, merge, type State, signersOf } from "../state.js";
import { bytesToWireHex, messageToWire } from "../wire.js";

const NONCE = REJECTION_DETAILS.nonce;
const KEY_REQUEST = "invalid signed key request";

/** Message types the mock can merge; anything else is refused. */
const SUPPORTED = new Set([
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
  MessageType.USER_DATA_ADD,
]);

/**
 * POST /v1/submitMessage (merge = true) and /v1/validateMessage (merge = false).
 * Checks run in roughly the order a node applies them: decoding, hash and envelope signature,
 * then the per-type rules from the gasless signer guide.
 */
export async function submit(state: State, bytes: Uint8Array, mergeIt: boolean): Promise<Reply> {
  let message: Message;
  try {
    message = Message.decode(bytes);
  } catch {
    return nodeError(400, "bad_request.parse_failure", "could not decode Message");
  }
  if (mergeIt) state.stats.submits++;

  const forced = state.control.rejectNextWith;
  if (forced && mergeIt) {
    state.control.rejectNextWith = undefined;
    const details = REJECTION_DETAILS[forced];
    return forced === "unavailable" ? nodeError(503, "unavailable", details) : rejected(details);
  }

  const problem = await check(state, message);
  if (problem) return rejected(problem);

  const wire = messageToWire(message);
  if (!mergeIt) return ok({ valid: true, message: wire });
  if (state.control.failReadsAfterSubmit > 0) {
    state.control.failReads = state.control.failReadsAfterSubmit;
    state.control.failReadsAfterSubmit = 0;
  }
  if (state.control.dropNextSubmit) {
    state.control.dropNextSubmit = false;
  } else if (state.control.mergeDelayMs > 0) {
    setTimeout(() => merge(state, message), state.control.mergeDelayMs);
  } else {
    merge(state, message);
  }
  return ok(wire);
}

async function check(state: State, message: Message): Promise<string | undefined> {
  const data = message.data;
  if (!data) return "message has no data";
  // Our own KEY_ADD rules first, so an inadmissible scope reports as the node does.
  if (data.type === MessageType.KEY_ADD) {
    const scopes = data.keyAddBody?.scopes ?? [];
    if (scopes.length === 0 || !scopes.every((s) => ADMISSIBLE_KEY_ADD_SCOPES.includes(s))) {
      return "invalid scope";
    }
  }
  const valid = await validations.validateMessage(message);
  if (valid.isErr()) return valid.error.message;
  if (!state.fids.has(data.fid)) return "unknown fid";

  if (data.type === MessageType.KEY_ADD) return checkKeyAdd(state, data);
  if (data.type === MessageType.KEY_REMOVE) return checkKeyRemove(state, message, data);

  const signer = activeSigner(state, data.fid, bytesToWireHex(message.signer));
  if (!signer) return "invalid signer";
  if (signer.source === "SIGNER_SOURCE_OFFCHAIN" && !signer.scopes.includes(data.type)) {
    return "invalid scope";
  }
  if (!SUPPORTED.has(data.type)) return "message type not supported by the mock";
  if ((state.storage.get(data.fid)?.units ?? 0) < 1) return "no storage units";
  return undefined;
}

async function checkKeyAdd(state: State, data: MessageData): Promise<string | undefined> {
  const body = data.keyAddBody;
  if (!body) return "missing keyAddBody";
  const entry = signersOf(state, data.fid);
  if (body.nonce <= entry.currentUserNonce) return NONCE;

  const custody = custodyOf(state, data.fid);
  if (!custody) return "invalid signature";
  const signed = {
    fid: BigInt(data.fid),
    key: body.key,
    keyType: body.keyType,
    scopes: body.scopes,
    ttl: body.ttl,
    nonce: body.nonce,
    deadline: BigInt(body.deadline),
  };
  // declare const verifyKeyAdd: (message: GaslessKeyAddMessage, signature: Uint8Array, address: Uint8Array) => HubAsyncResult<boolean>;
  if (
    !(
      await verifyKeyAdd(signed, body.custodySignature, hexToBytes(custody as `0x${string}`))
    ).unwrapOr(false)
  ) {
    return "invalid signature";
  }

  // declare const decodeGaslessSignedKeyRequestMetadata: (metadata: Uint8Array) => HubResult<GaslessSignedKeyRequestMetadata>;
  const meta = decodeGaslessSignedKeyRequestMetadata(body.metadata);
  if (meta.isErr()) return KEY_REQUEST;
  const { requestFid, requestSigner, signature, deadline } = meta.value;
  if (requestSigner.toLowerCase() !== custodyOf(state, Number(requestFid))) return KEY_REQUEST;
  const request = { requestFid, key: body.key, deadline };
  // declare const verifyGaslessKeyRequest: (message: GaslessSignedKeyRequestMessage, signature: Uint8Array, address: Uint8Array) => HubAsyncResult<boolean>;
  if (
    !(await verifyGaslessKeyRequest(request, signature, hexToBytes(requestSigner))).unwrapOr(false)
  ) {
    return KEY_REQUEST;
  }

  const gasless = entry.signers.filter((s) => s.source === "SIGNER_SOURCE_OFFCHAIN").length;
  if (gasless >= MAX_GASLESS_KEYS_PER_FID) return "active key cap exceeded";
  return undefined;
}

async function checkKeyRemove(
  state: State,
  message: Message,
  data: MessageData,
): Promise<string | undefined> {
  const body = data.keyRemoveBody;
  if (!body) return "missing keyRemoveBody";
  const entry = signersOf(state, data.fid);
  const key = bytesToWireHex(body.key);
  const target = entry.signers.find((s) => s.key === key);
  if (!target) return "unknown key";

  if (body.signatureType === KEY_REMOVE_SIGNATURE_TYPE_SELF) {
    if (bytesToWireHex(message.signer) !== key) return "invalid signature";
    const appNonce = entry.requesterFidNonces[String(target.requestFid ?? 0)] ?? 0;
    return body.nonce <= appNonce ? NONCE : undefined;
  }
  if (body.nonce <= entry.currentUserNonce) return NONCE;
  const custody = custodyOf(state, data.fid);
  if (!custody) return "invalid signature";
  const signed = {
    fid: BigInt(data.fid),
    key: body.key,
    nonce: body.nonce,
    deadline: BigInt(body.deadline),
  };
  // declare const verifyKeyRemove: (message: GaslessKeyRemoveMessage, signature: Uint8Array, address: Uint8Array) => HubAsyncResult<boolean>;
  const verified = await verifyKeyRemove(
    signed,
    body.signature,
    hexToBytes(custody as `0x${string}`),
  );
  return verified.unwrapOr(false) ? undefined : "invalid signature";
}
