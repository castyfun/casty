import {
  decodeGaslessSignedKeyRequestMetadata,
  KEY_REMOVE_SIGNATURE_TYPE_SELF,
  type Message,
  MessageType,
} from "@farcaster/core";
import { type Control, defaultControl } from "./control.js";
import type { Fixtures } from "./fixtures.js";
import {
  bytesToWireHex,
  messageFromWire,
  messageToWire,
  type WireMessage,
  type WireOnChainEvent,
  type WireSigner,
  type WireSigners,
  type WireStorageLimits,
} from "./wire.js";

export interface Stats {
  infoCalls: number;
  submits: number;
  inFlight: number;
  maxInFlight: number;
}

/** As the node prints an event: every merge lands in shard 1 here, one event per block. */
export interface HubEvent {
  type: "HUB_EVENT_TYPE_MERGE_MESSAGE";
  id: number;
  shardIndex: number;
  blockNumber: number;
  mergeMessageBody: { message: WireMessage; deletedMessages: WireMessage[] };
}

/** Everything the mock knows. One instance per mock node; the only mutable state in the mock. */
export interface State {
  fids: Set<number>;
  casts: WireMessage[];
  links: WireMessage[];
  reactions: WireMessage[];
  userdata: WireMessage[];
  verifications: WireMessage[];
  signers: Map<number, WireSigners>;
  storage: Map<number, WireStorageLimits>;
  onchain: WireOnChainEvent[];
  events: HubEvent[];
  control: Control;
  blockDelayCursor: number;
  stats: Stats;
}

export function createState(fixtures: Fixtures): State {
  const f = structuredClone(fixtures);
  return {
    fids: new Set(f.fids),
    casts: f.casts,
    links: f.links,
    reactions: f.reactions,
    userdata: f.userdata,
    verifications: f.verifications,
    signers: new Map(Object.entries(f.signers).map(([fid, s]) => [Number(fid), s])),
    storage: new Map(Object.entries(f.storage).map(([fid, s]) => [Number(fid), s])),
    onchain: f.onchain,
    events: [],
    control: defaultControl(),
    blockDelayCursor: 0,
    stats: { infoCalls: 0, submits: 0, inFlight: 0, maxInFlight: 0 },
  };
}

export function applyControl(state: State, patch: Partial<Control>): void {
  const { emitEvents, ...rest } = patch;
  Object.assign(state.control, rest);
  if (patch.blockDelay) state.blockDelayCursor = 0;
  for (const wire of emitEvents ?? []) merge(state, messageFromWire(wire));
}

/** The blockDelay for this /v1/info call; advances through the control sequence. */
export function nextBlockDelay(state: State): number {
  const sequence = state.control.blockDelay;
  const value = sequence[Math.min(state.blockDelayCursor, sequence.length - 1)] ?? 0;
  state.blockDelayCursor++;
  return value;
}

export function signersOf(state: State, fid: number): WireSigners {
  let entry = state.signers.get(fid);
  if (!entry) {
    entry = { signers: [], currentUserNonce: 0, requesterFidNonces: {} };
    state.signers.set(fid, entry);
  }
  return entry;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function activeSigner(state: State, fid: number, key: string): WireSigner | undefined {
  const signer = signersOf(state, fid).signers.find((s) => s.key === key);
  if (!signer) return undefined;
  if (signer.expiresAt && signer.expiresAt < nowSeconds()) return undefined;
  return signer;
}

/** Lowercase custody address of `fid`, from its latest id-registry event. */
export function custodyOf(state: State, fid: number): string | undefined {
  const events = state.onchain.filter((e) => e.fid === fid && e.idRegisterEventBody);
  return events.at(-1)?.idRegisterEventBody?.to.toLowerCase();
}

/** Messages of one kind that are replaced by a newer message with the same key. */
const sameTarget = {
  reaction: (a: WireMessage, b: WireMessage) =>
    a.data.fid === b.data.fid &&
    a.data.reactionBody?.type === b.data.reactionBody?.type &&
    a.data.reactionBody?.targetCastId?.hash === b.data.reactionBody?.targetCastId?.hash,
  link: (a: WireMessage, b: WireMessage) =>
    a.data.fid === b.data.fid &&
    a.data.linkBody?.type === b.data.linkBody?.type &&
    a.data.linkBody?.targetFid === b.data.linkBody?.targetFid,
  userdata: (a: WireMessage, b: WireMessage) =>
    a.data.fid === b.data.fid && a.data.userDataBody?.type === b.data.userDataBody?.type,
};

function replace(
  list: WireMessage[],
  wire: WireMessage,
  same: typeof sameTarget.link,
): WireMessage[] {
  return [...list.filter((m) => !same(m, wire)), wire];
}

/**
 * Applies an already validated message, the way a node merges it into its stores. The event
 * names what the merge displaced, as the node's `deletedMessages` does: the cast a remove
 * took, the reaction or link an add replaced or a remove took, the user data an add replaced.
 */
export function merge(state: State, message: Message): void {
  const wire = messageToWire(message);
  const data = message.data;
  if (!data) return;
  const fid = data.fid;
  let deleted: WireMessage[] = [];

  switch (data.type) {
    case MessageType.CAST_ADD:
      if (!state.casts.some((c) => c.hash === wire.hash)) state.casts.push(wire);
      break;
    case MessageType.CAST_REMOVE: {
      const target = wire.data.castRemoveBody?.targetHash;
      deleted = state.casts.filter((c) => c.data.fid === fid && c.hash === target);
      state.casts = state.casts.filter((c) => !(c.data.fid === fid && c.hash === target));
      // Snapchain keeps the remove in the fid's cast store: castsByFid lists it.
      state.casts.push(wire);
      break;
    }
    case MessageType.REACTION_ADD:
      deleted = state.reactions.filter((m) => sameTarget.reaction(m, wire));
      state.reactions = replace(state.reactions, wire, sameTarget.reaction);
      break;
    case MessageType.REACTION_REMOVE:
      deleted = state.reactions.filter((m) => sameTarget.reaction(m, wire));
      state.reactions = state.reactions.filter((m) => !sameTarget.reaction(m, wire));
      break;
    case MessageType.LINK_ADD:
      deleted = state.links.filter((m) => sameTarget.link(m, wire));
      state.links = replace(state.links, wire, sameTarget.link);
      break;
    case MessageType.LINK_REMOVE:
      deleted = state.links.filter((m) => sameTarget.link(m, wire));
      state.links = state.links.filter((m) => !sameTarget.link(m, wire));
      break;
    case MessageType.USER_DATA_ADD:
      deleted = state.userdata.filter((m) => sameTarget.userdata(m, wire));
      state.userdata = replace(state.userdata, wire, sameTarget.userdata);
      break;
    case MessageType.KEY_ADD:
      mergeKeyAdd(state, message);
      break;
    case MessageType.KEY_REMOVE:
      mergeKeyRemove(state, message);
      break;
  }

  const signer = activeSigner(state, fid, bytesToWireHex(message.signer));
  if (signer?.ttl) {
    signer.lastUsedAt = nowSeconds();
    signer.expiresAt = signer.lastUsedAt + signer.ttl;
  }
  state.events.push({
    type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
    id: state.events.length + 1,
    shardIndex: 1,
    blockNumber: 1_000_000 + state.events.length + 1,
    mergeMessageBody: { message: wire, deletedMessages: deleted },
  });
}

function mergeKeyAdd(state: State, message: Message): void {
  const fid = message.data?.fid ?? 0;
  const body = message.data?.keyAddBody;
  if (!body) return;
  const meta = decodeGaslessSignedKeyRequestMetadata(body.metadata)._unsafeUnwrap();
  const now = nowSeconds();
  const entry = signersOf(state, fid);
  entry.signers.push({
    source: "SIGNER_SOURCE_OFFCHAIN",
    key: bytesToWireHex(body.key),
    keyType: body.keyType,
    fid,
    addedAt: now,
    lastUsedAt: now,
    ttl: body.ttl,
    expiresAt: now + body.ttl,
    scopes: body.scopes,
    requestFid: Number(meta.requestFid),
    nonce: body.nonce,
  });
  entry.currentUserNonce = body.nonce;
}

function mergeKeyRemove(state: State, message: Message): void {
  const fid = message.data?.fid ?? 0;
  const body = message.data?.keyRemoveBody;
  if (!body) return;
  const entry = signersOf(state, fid);
  const key = bytesToWireHex(body.key);
  const removed = entry.signers.find((s) => s.key === key);
  entry.signers = entry.signers.filter((s) => s.key !== key);
  if (body.signatureType === KEY_REMOVE_SIGNATURE_TYPE_SELF) {
    entry.requesterFidNonces[String(removed?.requestFid ?? 0)] = body.nonce;
  } else {
    entry.currentUserNonce = body.nonce;
  }
}
