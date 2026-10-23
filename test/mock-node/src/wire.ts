import { Message } from "@farcaster/core";

/**
 * JSON as the Snapchain HTTP API prints it: protobuf JSON with enums as names, hashes,
 * keys and addresses as 0x hex, signatures and other bytes as base64. @farcaster/core `toJSON`
 * gives everything as base64, so the fields below are converted. Where the reference is
 * silent the @farcaster/core shape is kept.
 */
const HEX_FIELDS = new Set([
  "hash",
  "signer",
  "targetHash",
  "key",
  "to",
  "from",
  "recoveryAddress",
  "blockHash",
  "transactionHash",
  "owner",
  "address",
]);

export interface WireCastId {
  fid: number;
  hash: string;
}

export interface WireMessageData {
  type: string;
  fid: number;
  timestamp: number;
  network: string;
  castAddBody?: {
    text: string;
    parentCastId?: WireCastId;
    parentUrl?: string;
    mentions: number[];
    mentionsPositions: number[];
    embeds: { url?: string; castId?: WireCastId }[];
  };
  castRemoveBody?: { targetHash: string };
  reactionBody?: { type: string; targetCastId?: WireCastId; targetUrl?: string };
  linkBody?: { type: string; targetFid?: number };
  userDataBody?: { type: string; value: string };
  verificationAddAddressBody?: {
    address: string;
    claimSignature?: string;
    blockHash?: string;
    verificationType?: number;
    chainId?: number;
    protocol?: string;
  };
}

export interface WireMessage {
  data: WireMessageData;
  hash: string;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  signer: string;
}

export interface WireSigner {
  source: "SIGNER_SOURCE_ONCHAIN" | "SIGNER_SOURCE_OFFCHAIN";
  key: string;
  keyType: number;
  fid: number;
  addedAt?: number;
  lastUsedAt?: number;
  ttl?: number;
  expiresAt?: number;
  scopes: number[];
  requestFid?: number;
  nonce?: number;
  onChainEvent?: WireOnChainEvent;
}

/** One fid's entry in signers.json: the signersByFid response without paging fields. */
export interface WireSigners {
  signers: WireSigner[];
  currentUserNonce: number;
  requesterFidNonces: Record<string, number>;
}

export interface WireOnChainEvent {
  type: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  transactionHash: string;
  logIndex: number;
  fid: number;
  txIndex: number;
  idRegisterEventBody?: { to: string; eventType: string; from: string; recoveryAddress: string };
  signerEventBody?: {
    key: string;
    keyType: number;
    eventType: string;
    metadata: string;
    metadataType: number;
  };
}

export interface WireStorageLimits {
  limits: {
    storeType: string;
    name: string;
    limit: number;
    used: number;
    earliestTimestamp: number;
    earliestHash: unknown[];
  }[];
  units: number;
  unit_details: { unitType: string; unitSize: number }[];
}

function convert(value: unknown, field: (s: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, field));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === "string" && HEX_FIELDS.has(k) ? field(v) : convert(v, field),
    ]),
  );
}

export const bytesToWireHex = (bytes: Uint8Array): string =>
  `0x${Buffer.from(bytes).toString("hex")}`;
const base64ToHex = (s: string) => bytesToWireHex(Buffer.from(s, "base64"));
const hexToBase64 = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex").toString("base64");

export function messageToWire(message: Message): WireMessage {
  const { dataBytes: _, ...json } = Message.toJSON(message) as Record<string, unknown>;
  return convert(json, base64ToHex) as WireMessage;
}

export function messageFromWire(wire: WireMessage): Message {
  return Message.fromJSON(convert(wire, hexToBase64));
}
