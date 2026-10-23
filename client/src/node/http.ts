import { NodeError, NodeUnreachableError, nodeErrorFrom } from "./errors.js";

/**
 * Typed client for the Snapchain HTTP API (port 3381). Shapes follow the HTTP API reference:
 * hashes, keys and addresses are 0x hex, signatures base64, enums by name.
 */
export type Hex = `0x${string}`;

export interface CastId {
  fid: number;
  hash: Hex;
}

export interface CastAddBody {
  text: string;
  parentCastId?: CastId;
  parentUrl?: string;
  mentions: number[];
  mentionsPositions: number[];
  embeds: { url?: string; castId?: CastId }[];
}

export interface MessageData {
  type: string;
  fid: number;
  timestamp: number;
  network: string;
  castAddBody?: CastAddBody;
  castRemoveBody?: { targetHash: Hex };
  reactionBody?: { type: string; targetCastId?: CastId; targetUrl?: string };
  linkBody?: { type: string; targetFid?: number };
  userDataBody?: { type: string; value: string };
  /** An address the account proved it owns: `address` hex, `protocol` PROTOCOL_ETHEREUM or _SOLANA. */
  verificationAddAddressBody?: { address: string; protocol?: string; verificationType?: number };
}

export interface NodeMessage {
  data: MessageData;
  hash: Hex;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  signer: Hex;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  blockDelay: number;
  mempoolSize: number;
  approxSize: number;
  numMessages: number;
}

export interface NodeInfo {
  version: string;
  numShards: number;
  shardInfos: ShardInfo[];
  dbStats: { numMessages: number; numFidRegistrations: number; approxSize: number };
}

export interface OnChainEvent {
  type: string;
  fid: number;
  blockNumber: number;
  blockTimestamp: number;
  idRegisterEventBody?: { to: Hex; from: Hex; eventType: string };
  signerEventBody?: {
    key: Hex;
    keyType: number;
    eventType: string;
    metadata: string;
    metadataType: number;
  };
}

export interface SignerInfo {
  source: string;
  key: Hex;
  keyType: number;
  fid: number;
  addedAt?: number;
  lastUsedAt?: number;
  ttl?: number;
  /** Unix seconds. */
  expiresAt?: number;
  /** Message type names ("MESSAGE_TYPE_CAST_ADD"), as Snapchain 0.14 prints them, or numbers; none on an onchain key. */
  scopes?: (number | string)[];
  requestFid?: number;
  nonce?: number;
  onChainEvent?: OnChainEvent;
}

export interface Signers {
  signers: SignerInfo[];
  currentUserNonce: number;
  requesterFidNonces: Record<string, number>;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
}

export interface StorageLimits {
  units: number;
  limits: { name: string; limit: number; used: number }[];
}

export interface UserNameProof {
  name: string;
  fid: number;
  owner: string;
  timestamp: number;
  type: string;
}

/** One entry of the node's event log; the bodies casty reads. */
export interface HubEvent {
  type: string;
  /** Consecutive within a shard. A u64 on the node: taken as given, a number or a string. */
  id: number | string;
  shardIndex?: number;
  blockNumber?: number;
  mergeMessageBody?: { message: NodeMessage; deletedMessages?: NodeMessage[] };
  pruneMessageBody?: { message: NodeMessage };
  revokeMessageBody?: { message: NodeMessage };
}

export interface EventOptions extends PageOptions {
  /** The first event id wanted; 0 for the oldest the node keeps. */
  from?: number | undefined;
}

export interface Page<T> {
  items: T[];
  /** Empty when there are no more pages. */
  nextPageToken: string;
}

export interface PageOptions {
  pageSize?: number | undefined;
  pageToken?: string | undefined;
  reverse?: boolean | undefined;
}

export type ReactionKind = "Like" | "Recast";

type Params = Record<string, string | number | boolean | undefined>;

const TIMEOUT_MS = 15_000;
/** A mainnet node takes about 24 s to say not found for an address it has never seen. */
const ADDRESS_LOOKUP_TIMEOUT_MS = 60_000;

/** Yields every item of a paged endpoint, following nextPageToken until it is empty. */
export async function* allPages<T>(
  fetchPage: (pageToken?: string) => Promise<Page<T>>,
): AsyncGenerator<T> {
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(pageToken);
    yield* page.items;
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
}

/**
 * Snapchain answers a query that spans accounts (castsByMention, castsByParent) with pageSize
 * items from each shard, one shard's run after the other (seen on a mainnet node), so a page is
 * put in time order here: newest first with reverse, oldest first without.
 */
function inTimeOrder(page: Page<NodeMessage>, reverse: boolean | undefined): Page<NodeMessage> {
  const sign = reverse ? -1 : 1;
  return {
    ...page,
    items: page.items.toSorted(
      (a, b) => sign * (a.data.timestamp - b.data.timestamp) || a.hash.localeCompare(b.hash),
    ),
  };
}

export type NodeClient = ReturnType<typeof nodeClient>;

export function nodeClient(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request(
    path: string,
    init: RequestInit = {},
    timeoutMs = TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw new NodeUnreachableError(base, cause);
    }
  }

  async function json<T>(res: Response): Promise<T> {
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw nodeErrorFrom(res.status, body);
    if (body === undefined) {
      throw new NodeError(`${base} answered with something that is not JSON`, {
        status: res.status,
        hint: "--node should be a Snapchain node's HTTP API, usually on port 3381",
      });
    }
    return body as T;
  }

  function query(params: Params): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    // Brackets stay raw: the node's serde_qs reads requesterFids[0] as a list and ignores
    // requesterFids%5B0%5D. Keys are casty's own, so only theirs are ever bracketed.
    const text = search.toString().replace(/%5B(\d*)%5D=/g, "[$1]=");
    return text ? `?${text}` : "";
  }

  const get = async <T>(path: string, params: Params = {}, timeoutMs?: number): Promise<T> =>
    json<T>(await request(`${path}${query(params)}`, {}, timeoutMs));

  /** Like `get`, but a not_found answer becomes `undefined`. */
  async function find<T>(path: string, params: Params, timeoutMs?: number): Promise<T | undefined> {
    try {
      return await get<T>(path, params, timeoutMs);
    } catch (error) {
      if (error instanceof NodeError && error.errCode === "not_found") return undefined;
      throw error;
    }
  }

  async function list<T>(path: string, params: Params, key = "messages"): Promise<Page<T>> {
    const body = await get<Record<string, T[] | string | undefined>>(path, params);
    const items = body[key];
    return {
      items: Array.isArray(items) ? items : [],
      nextPageToken: String(body.nextPageToken ?? ""),
    };
  }

  const paging = (options: PageOptions = {}): Params => ({
    pageSize: options.pageSize,
    pageToken: options.pageToken,
    reverse: options.reverse,
  });

  async function post<T>(path: string, bytes: Uint8Array): Promise<T> {
    const init = {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    };
    return json<T>(await request(path, init));
  }

  return {
    url: base,

    /** Node status plus the node's clock from the HTTP Date header. */
    async info(): Promise<{ info: NodeInfo; date: Date | undefined }> {
      const res = await request("/v1/info");
      const date = res.headers.get("date");
      return { info: await json<NodeInfo>(res), date: date ? new Date(date) : undefined };
    },

    castById: (fid: number, hash: Hex) => find<NodeMessage>("/v1/castById", { fid, hash }),
    // The fid's cast store holds the removes of deleted casts too; a remove has no text to show.
    castsByFid: async (fid: number, options?: PageOptions) => {
      const page = await list<NodeMessage>("/v1/castsByFid", { fid, ...paging(options) });
      return { ...page, items: page.items.filter((m) => m.data.castAddBody) };
    },
    castsByParent: async (parent: CastId | { url: string }, options?: PageOptions) =>
      inTimeOrder(
        await list<NodeMessage>("/v1/castsByParent", { ...parent, ...paging(options) }),
        options?.reverse,
      ),
    castsByMention: async (fid: number, options?: PageOptions) =>
      inTimeOrder(
        await list<NodeMessage>("/v1/castsByMention", { fid, ...paging(options) }),
        options?.reverse,
      ),

    reactionsByFid: (fid: number, type: ReactionKind, options?: PageOptions) =>
      list<NodeMessage>("/v1/reactionsByFid", { fid, reaction_type: type, ...paging(options) }),
    reactionById: (fid: number, type: ReactionKind, target: CastId) =>
      find<NodeMessage>("/v1/reactionById", {
        fid,
        reaction_type: type,
        target_fid: target.fid,
        target_hash: target.hash,
      }),

    /** The follow from `fid` to `target`; undefined when there is none. */
    linkById: (fid: number, target: number) =>
      find<NodeMessage>("/v1/linkById", { fid, target_fid: target, link_type: "follow" }),
    linksByFid: (fid: number, options?: PageOptions) =>
      list<NodeMessage>("/v1/linksByFid", { fid, link_type: "follow", ...paging(options) }),

    /**
     * Every user data message of `fid`, or those of one type. Snapchain 0.14 pages all of them
     * whatever user_data_type says (seen on a mainnet node), so the type is applied here.
     */
    async userDataByFid(fid: number, type?: string): Promise<NodeMessage[]> {
      const { items } = await list<NodeMessage>("/v1/userDataByFid", { fid });
      return type ? items.filter((m) => m.data.userDataBody?.type === type) : items;
    },

    /** The addresses `fid` has verified as its own (VerificationAddAddress messages). */
    verificationsByFid: (fid: number, options?: PageOptions) =>
      list<NodeMessage>("/v1/verificationsByFid", { fid, ...paging(options) }),
    /** The fid's id-registry events, oldest first: the newest names its custody address. */
    idRegisterEventsByFid: async (fid: number): Promise<OnChainEvent[]> =>
      (
        await get<{ events?: OnChainEvent[] }>("/v1/onChainEventsByFid", {
          fid,
          event_type: "EVENT_TYPE_ID_REGISTER",
        })
      ).events ?? [],

    // A list is requesterFids[0]=1&requesterFids[1]=2 to the node's serde_qs; requesterFids=1,
    // or 1,2, is refused with HTTP 400 (seen on a mainnet node).
    signersByFid: (fid: number, requesterFids: number[] = []) =>
      get<Signers>("/v1/signersByFid", {
        fid,
        ...Object.fromEntries(requesterFids.map((f, i) => [`requesterFids[${i}]`, f])),
      }),
    idRegistryEventByAddress: (address: Hex) =>
      find<OnChainEvent>(
        "/v1/onChainIdRegistryEventByAddress",
        { address: address.toLowerCase() },
        ADDRESS_LOOKUP_TIMEOUT_MS,
      ),
    storageLimitsByFid: (fid: number) => get<StorageLimits>("/v1/storageLimitsByFid", { fid }),
    userNameProofByName: (name: string) => find<UserNameProof>("/v1/userNameProofByName", { name }),

    /** The event log of one shard from `from` on; the node keeps about three days of it. */
    events: (shard: number, options: EventOptions = {}) =>
      list<HubEvent>(
        "/v1/events",
        { shard_index: shard, from_event_id: options.from, ...paging(options) },
        "events",
      ),

    /** 200 means accepted for relay, not merged; see submit/confirm.ts. */
    submitMessage: (bytes: Uint8Array) => post<NodeMessage>("/v1/submitMessage", bytes),
  };
}
