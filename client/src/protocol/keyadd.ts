import {
  type Eip712Signer,
  type Message,
  type MessageType,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBody,
  makeKeyRemoveBodySelfRevoke,
  type Signer,
} from "@farcaster/core";
import { NETWORK, unwrap } from "./messages.js";
import { farcasterNow } from "./time.js";

/** Custody authorizations expire an hour (of Farcaster time) after they are signed. */
export function authDeadline(): number {
  return farcasterNow() + 3600;
}

export interface KeyAddInput {
  fid: number;
  key: Uint8Array;
  scopes: MessageType[];
  ttl: number;
  /** As read from signersByFid; the message uses the next value. */
  currentUserNonce: number;
  deadline: number;
  requestFid?: number | undefined;
}

/**
 * Gasless KEY_ADD: the custody address authorizes `key`, the app named by `requestFid`
 * (default: the user's own fid) vouches for it, and `newKey` signs the envelope.
 */
export async function buildKeyAdd(
  input: KeyAddInput,
  custody: Eip712Signer,
  newKey: Signer,
  appCustody?: Eip712Signer,
): Promise<Message> {
  const options = {
    fid: BigInt(input.fid),
    key: input.key,
    scopes: input.scopes,
    ttl: input.ttl,
    nonce: input.currentUserNonce + 1,
    deadline: input.deadline,
    requestFid: BigInt(input.requestFid ?? input.fid),
  };
  // declare const makeKeyAddBody: (options: KeyAddBodyOptions, custodySigner: Eip712Signer, requestSigner?: Eip712Signer) => HubAsyncResult<KeyAddBody>;
  const body = unwrap(await makeKeyAddBody(options, custody, appCustody));
  // declare const makeKeyAdd: (body: KeyAddBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<KeyAddMessage>;
  return unwrap(await makeKeyAdd(body, { fid: input.fid, network: NETWORK }, newKey));
}

export interface CustodyRevokeInput {
  fid: number;
  key: Uint8Array;
  currentUserNonce: number;
  deadline: number;
}

/** KEY_REMOVE authorized by the custody address; any ed25519 key may sign the envelope. */
export async function buildCustodyRevoke(
  input: CustodyRevokeInput,
  custody: Eip712Signer,
  envelopeSigner: Signer,
): Promise<Message> {
  const options = {
    fid: BigInt(input.fid),
    key: input.key,
    nonce: input.currentUserNonce + 1,
    deadline: input.deadline,
  };
  // declare const makeKeyRemoveBody: (options: KeyRemoveBodyOptions, custodySigner: Eip712Signer) => HubAsyncResult<KeyRemoveBody>;
  const body = unwrap(await makeKeyRemoveBody(options, custody));
  // declare const makeKeyRemove: (body: KeyRemoveBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<KeyRemoveMessage>;
  return unwrap(await makeKeyRemove(body, { fid: input.fid, network: NETWORK }, envelopeSigner));
}

export interface SelfRevokeInput {
  fid: number;
  /** The requesting app's entry in signersByFid `requesterFidNonces`. */
  requesterNonce: number;
  deadline: number;
}

/** KEY_REMOVE signed by the key being removed; no custody signature needed. */
export async function buildSelfRevoke(input: SelfRevokeInput, key: Signer): Promise<Message> {
  const pubkey = unwrap(await key.getSignerKey());
  const options = { key: pubkey, nonce: input.requesterNonce + 1, deadline: input.deadline };
  // declare const makeKeyRemoveBodySelfRevoke: (options: Pick<KeyRemoveBodyOptions, "key" | "nonce" | "deadline">) => HubResult<KeyRemoveBody>;
  const body = unwrap(makeKeyRemoveBodySelfRevoke(options));
  return unwrap(await makeKeyRemove(body, { fid: input.fid, network: NETWORK }, key));
}
