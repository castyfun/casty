import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { DEFAULT_SCOPE_NAMES } from "../config.js";
import { UsageError } from "../errors.js";
import { generateKey, type KeyPair } from "../keys/signer.js";
import type { KeyRecord } from "../keys/store.js";
import { NonceError } from "../node/errors.js";
import type { Hex, NodeClient } from "../node/http.js";
import { authDeadline } from "../protocol/keyadd.js";
import { parseScopes } from "../protocol/scopes.js";
import { parseDuration } from "../protocol/time.js";
import type { ConfirmOptions } from "../submit/confirm.js";
import { HttpError } from "./api.js";

/**
 * An app key added with a wallet instead of a typed seed phrase. The custody address signs two
 * EIP-712 messages, the ones @farcaster/core's own signer would sign: the key request, which
 * names the app (here your own fid) asking for the key, and the key add, which authorises it.
 * The page hands both to the wallet in the browser (eth_signTypedData_v4) and brings the
 * signatures back; casty checks them against the custody address, sends the KEY_ADD through
 * the node and stores the key. The seed phrase never leaves the wallet.
 */
export interface KeyFlowDeps {
  node: NodeClient;
  config: Config;
  confirm: ConfirmOptions;
  /** Stores the record, encrypted, and makes it this casty's newest key. */
  addKey: (record: KeyRecord) => void;
}

/** EIP-712 typed data as eth_signTypedData_v4 takes it: uint256 values as decimal strings. */
export interface TypedData {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

interface Pending {
  key: KeyPair;
  add: {
    fid: bigint;
    key: Uint8Array;
    keyType: number;
    scopes: number[];
    ttl: number;
    nonce: number;
    deadline: bigint;
  };
  request: { requestFid: bigint; key: Uint8Array; deadline: bigint };
  at: number;
}

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];
/** A request the wallet did not answer within this is forgotten; the deadline is an hour too. */
const PENDING_MS = 3_600_000;
const TTL = "30d";

const core = () => import("@farcaster/core");
const hex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;

export function keyFlow(deps: KeyFlowDeps) {
  const pending = new Map<string, Pending>();
  const { fid } = deps.config;

  return {
    /** A fresh key and the two messages for the wallet to sign. */
    async start(): Promise<{
      id: string;
      key: Hex;
      custody: Hex;
      typedData: { request: TypedData; add: TypedData };
    }> {
      const hub = await core();
      for (const [id, p] of pending) if (Date.now() - p.at > PENDING_MS) pending.delete(id);
      const key = await generateKey();
      const { currentUserNonce } = await deps.node.signersByFid(fid);
      const deadline = authDeadline();
      const add = {
        fid: BigInt(fid),
        key: key.pubkey,
        keyType: hub.KEY_TYPE_ED25519,
        scopes: parseScopes(DEFAULT_SCOPE_NAMES),
        ttl: parseDuration(TTL),
        nonce: currentUserNonce + 1,
        deadline: BigInt(deadline),
      };
      const request = { requestFid: BigInt(fid), key: key.pubkey, deadline: BigInt(deadline) };
      const id = randomBytes(16).toString("base64url");
      pending.set(id, { key, add, request, at: Date.now() });
      const domain = { ...hub.GASLESS_KEY_EIP_712_DOMAIN };
      return {
        id,
        key: hex(key.pubkey),
        custody: deps.config.custodyAddress,
        typedData: {
          request: {
            domain,
            types: {
              EIP712Domain: DOMAIN_TYPE,
              SignedKeyRequest: [...hub.GASLESS_SIGNED_KEY_REQUEST_TYPE],
            },
            primaryType: "SignedKeyRequest",
            message: { requestFid: String(fid), key: hex(key.pubkey), deadline: String(deadline) },
          },
          add: {
            domain,
            types: { EIP712Domain: DOMAIN_TYPE, KeyAdd: [...hub.GASLESS_KEY_ADD_TYPE] },
            primaryType: "KeyAdd",
            message: {
              fid: String(fid),
              key: hex(key.pubkey),
              keyType: add.keyType,
              scopes: add.scopes,
              ttl: add.ttl,
              nonce: add.nonce,
              deadline: String(deadline),
            },
          },
        },
      };
    },

    /** The wallet's signatures: checked, sent as a KEY_ADD, the key stored once the node lists it. */
    async finish(id: string, signatures: { request: Hex; add: Hex }): Promise<{ key: Hex }> {
      const flow = pending.get(id);
      if (!flow || Date.now() - flow.at > PENDING_MS) {
        pending.delete(id);
        throw new HttpError(
          404,
          "no key request to finish, or it is over an hour old",
          "start again",
        );
      }
      const hub = await core();
      const { submitAndConfirm } = await import("../submit/confirm.js");
      const custody = deps.config.custodyAddress;
      const custodyBytes = Buffer.from(custody.slice(2), "hex");
      const request = Buffer.from(signatures.request.slice(2), "hex");
      const add = Buffer.from(signatures.add.slice(2), "hex");
      const [requestOk, addOk] = await Promise.all([
        hub.verifyGaslessKeyRequest(flow.request, request, custodyBytes),
        hub.verifyKeyAdd(flow.add, add, custodyBytes),
      ]);
      if (!requestOk.unwrapOr(false) || !addOk.unwrapOr(false)) {
        throw new UsageError(
          `the signatures are not the custody address's (${custody})`,
          "switch the wallet to the account that holds your fid and try again",
        );
      }
      const metadata = hub
        .encodeGaslessSignedKeyRequestMetadata({
          requestFid: flow.request.requestFid,
          requestSigner: custody,
          signature: request,
          deadline: flow.request.deadline,
        })
        ._unsafeUnwrap();
      const body = {
        key: flow.key.pubkey,
        keyType: flow.add.keyType,
        custodySignature: add,
        deadline: Number(flow.add.deadline),
        nonce: flow.add.nonce,
        metadata,
        metadataType: hub.METADATA_TYPE_SIGNED_KEY_REQUEST,
        registrationTxHash: new Uint8Array(),
        scopes: flow.add.scopes,
        ttl: flow.add.ttl,
      };
      const signer = new hub.NobleEd25519Signer(flow.key.privkey);
      const message = (
        await hub.makeKeyAdd(body, { fid, network: hub.FarcasterNetwork.MAINNET }, signer)
      )._unsafeUnwrap();
      const pubkey = hex(flow.key.pubkey);
      const record: KeyRecord = {
        fid,
        pubkey: pubkey.slice(2),
        privkey: Buffer.from(flow.key.privkey).toString("hex"),
        requestFid: fid,
        scopes: flow.add.scopes,
        ttl: flow.add.ttl,
        createdAt: new Date().toISOString(),
        network: "FARCASTER_NETWORK_MAINNET",
      };
      // Stored with the signed message first, as casty init does: a key that merges after the
      // wait is still usable, and casty init can resend the same bytes.
      const keyAdd = Buffer.from(hub.Message.encode(message).finish()).toString("hex");
      deps.addKey({ ...record, keyAdd });
      pending.delete(id);
      try {
        await submitAndConfirm(
          deps.node,
          message,
          async () => (await deps.node.signersByFid(fid)).signers.some((s) => s.key === pubkey),
          deps.confirm,
        );
      } catch (error) {
        if (error instanceof NonceError) {
          throw new HttpError(409, "another key change landed first", "start again");
        }
        throw error;
      } finally {
        flow.key.privkey.fill(0);
      }
      deps.addKey(record);
      return { key: pubkey };
    },
  };
}
