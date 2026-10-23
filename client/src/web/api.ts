import type { IncomingMessage } from "node:http";
import type { Signer } from "@farcaster/core";
import { syncStatus } from "../cli/doctor.js";
import { rememberFeed, resolveChannel, sawMentions, unseenMentions } from "../cli/refs.js";
import { type Config, namesCache } from "../config.js";
import { fidForName } from "../custody/fid.js";
import { CastyError, UsageError } from "../errors.js";
import { describeSigners, usernames, warmSigners } from "../feed/clients.js";
import { CONCURRENCY, followedFids, mapLimit } from "../feed/fanout.js";
import {
  describeCasts,
  feedCaches,
  followsCache,
  loadFeed,
  loadMentions,
  mentionCasts,
  noteFollow,
  readThread,
  threadCasts,
} from "../feed/feed.js";
import { clean, type FeedItem, formatAge } from "../feed/render.js";
import type { KeyRecord } from "../keys/store.js";
import type { Indexer } from "../local/indexer.js";
import type { CastId, Hex, NodeClient, NodeMessage, ReactionKind } from "../node/http.js";
import { mentionFids } from "../protocol/mentions.js";
import { MAX_CAST_BYTES, MAX_LONG_CAST_BYTES } from "../protocol/messages.js";
import { scopeGroupsOfNames } from "../protocol/scopes.js";
import { farcasterNow } from "../protocol/time.js";
import { deleteCast, follow, postCast, react, type Writer } from "../submit/actions.js";
import type { ConfirmOptions } from "../submit/confirm.js";
import { keyFlow } from "./keyflow.js";
import { type Push, parseSubscription } from "./push.js";
import { type Reacted, tidy, toWebCast, verificationOf } from "./view.js";

export interface WebDeps {
  node: NodeClient;
  dir: string;
  config: Config;
  confirm: ConfirmOptions;
  token: string;
  /** Asked for an @name the node does not know; absent, only the node is asked. */
  fnameServer?: string | undefined;
  /** Runs `fn` with the active app key. Without it the page is read-only. */
  sign?: <T>(fn: (signer: Signer) => Promise<T>) => Promise<T>;
  /** Stores a key added from the page, encrypted, as this casty's newest; absent when read-only. */
  addKey?: ((record: KeyRecord) => void) | undefined;
  /** casty serve's index: the feed, mentions and your reactions come from it once it is ready. */
  local?: Indexer | undefined;
  /** casty serve's push: the page subscribes a browser to mentions and replies. */
  push?: Push | undefined;
}

export type Route = (url: URL, req: IncomingMessage) => Promise<unknown>;

/** An error with the HTTP status to answer it with. */
export class HttpError extends CastyError {
  readonly status: number;

  constructor(status: number, message: string, hint?: string) {
    super(message, 1, hint);
    this.status = status;
  }
}

const MAX_BODY = 16 * 1024;
/** The same page runs from casty web, casty serve and, on the host, 1-node.sh serve. */
const READ_ONLY_HINT =
  "start it again without --read-only: casty web here, ./scripts/1-node.sh serve on the host";
/** How long a read is answered from memory. */
const READ_MEMORY_MS = 30_000;
/**
 * How long the mentions behind the count of new ones are shared: every open page asks every two
 * minutes, so a phone and a laptop reuse one read, while one page alone always reads afresh.
 */
const UNSEEN_MEMORY_MS = 90_000;
/** The most casts one feed request returns. */
const MAX_FEED = 200;
/** How many of an account's casts its profile shows. */
const PROFILE_CASTS = 30;
const MAX_EMBEDS = 2;

/** Your reactions of one kind read so far: what they are, where to go on, the oldest read. */
interface Reach {
  keys: Set<string>;
  token: string;
  oldest: number;
}

/** Your reactions as reacted() read them, with how far back each kind reaches. */
type Reactions = Reacted & { reach: Record<ReactionKind, Reach> };

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "send the request as application/json");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "the request is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {}
  throw new UsageError("the request body is not a JSON object");
}

function fidOf(value: unknown, name: string): number {
  if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
  throw new UsageError(`${name} must be a positive whole number`);
}

function castId(value: unknown, name: string): CastId {
  const v = value as Partial<CastId> | null;
  if (typeof v === "object" && v !== null && typeof v.hash === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(v.hash)) {
      return { fid: fidOf(v.fid, `${name}.fid`), hash: v.hash.toLowerCase() as Hex };
    }
  }
  throw new UsageError(`${name} must be { fid, hash } with a 0x hash of 40 hex digits`);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  throw new UsageError(`${name} must be a string`);
}

function embedsOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const urls = Array.isArray(value) ? value : [value];
  if (
    urls.length > MAX_EMBEDS ||
    !urls.every((u) => typeof u === "string" && /^https?:\/\/\S+$/i.test(u))
  ) {
    throw new UsageError(`embeds must be at most ${MAX_EMBEDS} http(s) links`);
  }
  return urls.length > 0 ? (urls as string[]) : undefined;
}

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);
const query = (url: URL, name: string) => url.searchParams.get(name);

/**
 * `node` with each read remembered for `ttlMs`, keyed by the method and its arguments; a read
 * that fails is not remembered. `forget` drops everything, after a write or on refresh.
 */
function remembering(node: NodeClient, ttlMs: number) {
  const memo = new Map<string, { at: number; value: Promise<unknown> }>();
  // Writes, and the node's status: its sync and its clock (the Date header) must be current.
  const fresh = new Set(["submitMessage", "info"]);
  let swept = 0;
  const remembered = Object.fromEntries(
    Object.entries(node).map(([name, method]) => {
      if (typeof method !== "function" || fresh.has(name)) return [name, method];
      const read = (...args: unknown[]) => {
        const key = `${name}:${JSON.stringify(args)}`;
        const hit = memo.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = (method as (...a: unknown[]) => Promise<unknown>)(...args);
        const now = Date.now();
        // Stale reads are swept at most once per ttl, so a long session keeps no old pages and a
        // feed of thousands of accounts does not rescan the map on every read.
        if (now - swept >= ttlMs) {
          for (const [k, entry] of memo) if (now - entry.at >= ttlMs) memo.delete(k);
          swept = now;
        }
        memo.set(key, { at: now, value });
        value.catch(() => {
          if (memo.get(key)?.value === value) memo.delete(key);
        });
        return value;
      };
      return [name, read];
    }),
  ) as NodeClient;
  return { node: remembered, forget: () => memo.clear() };
}

/** The JSON API, keyed by "METHOD /path". Any read with refresh=1 asks the node afresh. */
export function apiRoutes(deps: WebDeps): Record<string, Route> {
  const routes = routesOf(deps);
  return Object.fromEntries(
    Object.entries(routes.routes).map(([key, route]) => [
      key,
      key.startsWith("GET ")
        ? (url: URL, req: IncomingMessage) => {
            // refresh=1 reads everything afresh, the follow list too; reload=1, a page load, reads
            // casts afresh and takes the follow list from its cache.
            if (query(url, "refresh") === "1" || query(url, "reload") === "1") routes.forget();
            return route(url, req);
          }
        : route,
    ]),
  );
}

function routesOf(deps: WebDeps): { routes: Record<string, Route>; forget: () => void } {
  const { config } = deps;
  // Reads go through a short memory, so toggling a filter or showing more does not ask every
  // followed account again. Writes, and the reads that confirm them, go to the node itself.
  const memory = remembering(deps.node, READ_MEMORY_MS);
  let unseen: { at: number; limit: number; casts: Promise<NodeMessage[]> } | undefined;
  const forget = () => {
    memory.forget();
    unseen = undefined;
  };
  const node = memory.node;
  const { fid } = config;
  /** The index, while it can answer; a cold one leaves the reads to the fan-out. */
  const index = () => (deps.local?.ready() ? deps.local.index : undefined);
  // Once the index can answer, the names and apps of your follows are read too, so the first
  // feed after a start asks the node for nothing at all.
  deps.local?.started
    .then(async () => {
      const store = deps.local?.index;
      if (!store) return;
      const everyone = [fid, ...store.follows(fid)];
      await Promise.all([
        usernames(node, everyone, caches.names),
        warmSigners(node, everyone, caches.signers),
      ]);
      // The apps behind their keys are named on every cast too.
      const apps = new Set<number>();
      for (const account of everyone) {
        for (const app of Object.values(caches.signers.get(String(account)) ?? {})) {
          if (app) apps.add(app);
        }
      }
      await usernames(node, [...apps], caches.names);
      caches.names.save();
    })
    .catch(() => {});
  const names = namesCache(deps.dir);
  // Signers and usernames stay in memory for the life of the process and are written back when
  // they change, so a request does not read and parse them from disk again.
  const caches = feedCaches(deps.dir);
  // The feed's own follow list cache: read afresh here, so a follow made on the page shows there.
  const follows = () => followsCache(deps.dir);

  /**
   * Your newest 100 likes and recasts, read alongside a list, and how far back each reaches: with
   * more pages, a cast at or before the oldest of them may have a reaction past them.
   */
  async function reacted(): Promise<Reactions> {
    const local = index();
    if (local) {
      // The index holds every reaction of yours the first pass and the events gave it.
      const all = { keys: new Set<string>(), token: "", oldest: Number.NEGATIVE_INFINITY };
      const { likes, recasts } = local.reacted(fid);
      return {
        likes,
        recasts,
        reach: { Like: { ...all, keys: likes }, Recast: { ...all, keys: recasts } },
      };
    }
    const read = async (kind: ReactionKind): Promise<Reach> => {
      const reach: Reach = { keys: new Set(), token: "", oldest: 0 };
      await readOn(kind, reach);
      return reach;
    };
    const [Like, Recast] = await Promise.all([read("Like"), read("Recast")]);
    return { likes: Like.keys, recasts: Recast.keys, reach: { Like, Recast } };
  }

  /** The next page of your reactions of `kind` into `reach`. */
  async function readOn(kind: ReactionKind, reach: Reach): Promise<void> {
    const page = { reverse: true, pageSize: 100, pageToken: reach.token || undefined };
    const { items, nextPageToken } = await node.reactionsByFid(fid, kind, page);
    for (const r of items) {
      const target = r.data.reactionBody?.targetCastId;
      if (target) reach.keys.add(`${target.fid}:${target.hash}`);
    }
    reach.token = nextPageToken;
    reach.oldest = nextPageToken ? (items.at(-1)?.data.timestamp ?? 0) : Number.NEGATIVE_INFINITY;
  }

  /**
   * `reacts` completed for the casts too old for your newest 100 reactions to tell: a reaction is
   * never older than its cast, so your reactions are read further back until they reach the
   * oldest cast, up to 1000 of each, and a cast older still is asked about with reactionById.
   */
  async function reachBack(items: FeedItem[], reacts: Reactions): Promise<Reacted> {
    const oldest = Math.min(...items.map((item) => item.timestamp));
    await Promise.all(
      (["Like", "Recast"] as const).map(async (kind) => {
        const reach = reacts.reach[kind];
        for (let pages = 1; reach.token && oldest <= reach.oldest && pages < 10; pages++) {
          await readOn(kind, reach);
        }
      }),
    );
    const asks = items.flatMap((item) =>
      (["Like", "Recast"] as const)
        .filter((kind) => item.timestamp <= reacts.reach[kind].oldest)
        .map((kind) => ({ item, kind })),
    );
    await mapLimit(asks, CONCURRENCY, async ({ item, kind }) => {
      const known = kind === "Like" ? reacts.likes : reacts.recasts;
      const key = `${item.fid}:${item.hash}`;
      if (known.has(key)) return;
      if (await node.reactionById(fid, kind, { fid: item.fid, hash: item.hash })) known.add(key);
    });
    return reacts;
  }

  /** `mine` is passed when the caller asked for it early, alongside its own reads. */
  async function view(casts: NodeMessage[], mine: Promise<Reactions> = reacted()) {
    const [items, reacts] = await Promise.all([
      describeCasts(node, casts, { caches, ownKeys: config.keys }),
      mine,
    ]);
    const now = farcasterNow();
    const known = await reachBack(items, reacts);
    return items.map((item) => toWebCast(item, now, known));
  }

  /**
   * A list of casts as the page shows it. With number=1 its numbers are saved as `casty feed`
   * saves its own, so `casty like 3` in a terminal means the third cast on that page. Only the
   * newest such request writes: one started earlier that ends later would renumber an old list.
   * The answer carries its turn when it wrote, so a page that gets two answers out of order can
   * tell which list the terminal's numbers belong to; turns start from the clock, so they keep
   * growing across a restart.
   */
  let numbering = 0;
  const turnOf = (url: URL) => {
    if (query(url, "number") !== "1") return 0;
    numbering = Math.max(numbering + 1, Date.now());
    return numbering;
  };
  async function numbered(turn: number, items: FeedItem[], mine: Reactions) {
    const saved = turn > 0 && turn === numbering;
    if (saved) rememberFeed(deps.dir, items);
    const now = farcasterNow();
    const known = await reachBack(items, mine);
    return { items: items.map((item) => toWebCast(item, now, known)), turn: saved ? turn : 0 };
  }

  const limitOf = (url: URL) => Math.min(Math.max(Number(query(url, "limit")) || 30, 1), MAX_FEED);

  async function username(of: number): Promise<string | null> {
    const [data] = await node.userDataByFid(of, "USER_DATA_TYPE_USERNAME");
    return data?.data.userDataBody?.value ?? null;
  }

  /** Username, display name and bio, from one read of everything the account has set. */
  async function about(of: number) {
    const data = await node.userDataByFid(of);
    const value = (type: string) =>
      data.find((m) => m.data.userDataBody?.type === `USER_DATA_TYPE_${type}`)?.data.userDataBody
        ?.value || null;
    const display = value("DISPLAY");
    const bio = value("BIO");
    return {
      username: value("USERNAME"),
      display: display && (clean(display).trim() || null),
      bio: bio && (tidy(bio).trim() || null),
    };
  }

  /** Refuses a write on a read-only page, before anything is read for it. */
  function writable(): NonNullable<WebDeps["sign"]> {
    if (!deps.sign) {
      throw new HttpError(403, "this page is read-only", READ_ONLY_HINT);
    }
    return deps.sign;
  }

  async function write<T>(fn: (w: Writer) => Promise<T>): Promise<T> {
    const sign = writable();
    try {
      return await sign((signer) => fn({ node: deps.node, fid, signer, confirm: deps.confirm }));
    } finally {
      // The node has the write: its event is there to read, so the index shows it at once. A
      // cold index is still on its first pass, which a write does not wait for.
      if (deps.local?.ready()) await deps.local.catchUp().catch(() => {});
      forget();
    }
  }

  const routes: Record<string, Route> = {
    "GET /api/session": async () => {
      const [name, { info }, { signers }] = await Promise.all([
        username(fid),
        node.info(),
        node.signersByFid(fid),
      ]);
      const status = syncStatus(info);
      // When the soonest of this casty's keys lapses: a key the node lists, with a TTL.
      const lapses = signers
        .filter((s) => config.keys.includes(s.key) && s.expiresAt)
        .map((s) => s.expiresAt as number);
      return {
        fid,
        username: name,
        canWrite: deps.sign !== undefined,
        index: index() !== undefined,
        push: deps.push?.keys.publicKey ?? null,
        canAddKey: deps.addKey !== undefined,
        keyExpiresAt: lapses.length ? new Date(Math.min(...lapses) * 1000).toISOString() : null,
        limits: {
          cast: MAX_CAST_BYTES,
          longCast: MAX_LONG_CAST_BYTES,
          feed: MAX_FEED,
          embeds: MAX_EMBEDS,
        },
        node: {
          url: node.url,
          version: status.version,
          synced: status.synced,
          behind: formatAge(Math.max(0, ...status.shards.map((s) => s.blockDelay))),
        },
      };
    },

    "GET /api/me": async () => {
      const [name, signers, storage, { info, date }, verified] = await Promise.all([
        username(fid),
        describeSigners(node, fid, config.keys),
        node.storageLimitsByFid(fid),
        node.info(),
        node.verificationsByFid(fid),
      ]);
      const status = syncStatus(info);
      // Scopes as --scopes names them: "cast, reaction, link".
      const keys = signers.map((k) => ({
        ...k,
        scopes: k.type === "onchain" ? "all" : scopeGroupsOfNames(k.scopes).join(", "),
      }));
      return {
        fid,
        username: name,
        custody: config.custodyAddress,
        keys,
        /** Keys in this casty's store that the node no longer lists: expired or revoked. */
        lapsed: config.keys.filter((key) => !keys.some((k) => k.key === key)),
        verifications: verified.items.map(verificationOf).filter((v) => v !== undefined),
        storage: {
          units: storage.units,
          stores: storage.limits.map((l) => ({ store: l.name, used: l.used, limit: l.limit })),
        },
        node: {
          url: node.url,
          version: status.version,
          synced: status.synced,
          shards: status.shards,
          clockSkew: date ? Math.round((Date.now() - date.getTime()) / 1000) : null,
        },
        configDir: deps.dir,
      };
    },

    "GET /api/feed": async (url) => {
      const turn = turnOf(url);
      const [items, mine] = await Promise.all([
        loadFeed(node, {
          fid,
          limit: limitOf(url),
          replies: query(url, "replies") !== "0",
          channel: query(url, "channel") || undefined,
          onlyApps: list(query(url, "only")),
          excludeApps: list(query(url, "exclude")),
          refresh: query(url, "refresh") === "1",
          cacheDir: deps.dir,
          caches,
          ownKeys: config.keys,
          index: index(),
        }),
        reacted(),
      ]);
      return numbered(turn, items, mine);
    },

    "GET /api/mentions": async (url) => {
      const turn = turnOf(url);
      const options = { fid, limit: limitOf(url), caches, ownKeys: config.keys, index: index() };
      const [items, mine] = await Promise.all([loadMentions(node, options), reacted()]);
      sawMentions(deps.dir, fid, items);
      return numbered(turn, items, mine);
    },

    // How many mentions the tab has not shown yet, asked every few minutes for its badge.
    "GET /api/unseen": async (url) => {
      const limit = limitOf(url);
      if (!unseen || unseen.limit !== limit || Date.now() - unseen.at >= UNSEEN_MEMORY_MS) {
        const read = {
          at: Date.now(),
          limit,
          casts: mentionCasts(node, { fid, limit, index: index() }),
        };
        read.casts.catch(() => {
          if (unseen === read) unseen = undefined;
        });
        unseen = read;
      }
      // Counted against the newest mention shown as it is now, so a list just shown counts 0.
      const times = (await unseen.casts).map((c) => c.data.timestamp);
      return { mentions: unseenMentions(deps.dir, fid, times) };
    },

    "GET /api/thread": async (url) => {
      const id = castId({ fid: Number(query(url, "fid")), hash: query(url, "hash") }, "the cast");
      const mine = reacted();
      mine.catch(() => {});
      const thread = await readThread(node, id);
      if (!thread) throw new HttpError(404, `fid ${id.fid} has no cast ${id.hash}`);
      const shown = await view(threadCasts(thread), mine);
      const parent = thread.parent ? (shown.shift() ?? null) : null;
      const [cast, ...replies] = shown;
      return { parent, cast, replies };
    },

    "GET /api/profile": async (url) => {
      const of = fidOf(Number(query(url, "fid")), "fid");
      const mine = reacted();
      mine.catch(() => {});
      const [account, followed, signers, casts, verified] = await Promise.all([
        about(of),
        // From the feed's cache (a follow made here refreshes it); read afresh on refresh.
        followedFids(node, fid, follows(), query(url, "refresh") === "1"),
        describeSigners(node, of, of === fid ? config.keys : []),
        node.castsByFid(of, { reverse: true, pageSize: PROFILE_CASTS }),
        node.verificationsByFid(of),
      ]);
      const apps = new Map<number, { fid: number; name: string | null; keys: number }>();
      for (const s of signers) {
        if (s.requestFid === null) continue;
        const app = apps.get(s.requestFid) ?? { fid: s.requestFid, name: s.app, keys: 0 };
        apps.set(s.requestFid, { ...app, keys: app.keys + 1 });
      }
      return {
        fid: of,
        ...account,
        you: of === fid,
        following: followed.includes(of),
        apps: [...apps.values()],
        verifications: verified.items.map(verificationOf).filter((v) => v !== undefined),
        casts: await view(casts.items, mine),
      };
    },

    "GET /api/resolve": async (url) => {
      const name = optionalString(query(url, "name"), "name");
      if (!name) throw new UsageError("name a username, such as @alice");
      return { fid: await fidForName(node, name, deps.fnameServer, names) };
    },

    "POST /api/cast": async (_url, req) => {
      const body = await readJson(req);
      if (typeof body.text !== "string" || body.text.trim() === "") {
        throw new UsageError("text must be a string with something in it");
      }
      const text = body.text;
      const parent = body.parent == null ? undefined : castId(body.parent, "parent");
      const named = optionalString(body.channel, "channel");
      const channel = named === undefined ? undefined : resolveChannel(deps.dir, named);
      const embeds = embedsOf(body.embeds);
      writable();
      // A name nobody holds goes out as text, and the page says which.
      const lookup = (name: string) => fidForName(node, name, deps.fnameServer, names);
      const { fids, plain } = await mentionFids(text, lookup);
      const cast = await write((w) =>
        postCast(w, { text, parent, channel, embeds, mentions: fids }),
      );
      return { ...cast, plain };
    },

    "POST /api/react": async (_url, req) => {
      const body = await readJson(req);
      if (body.reaction !== "Like" && body.reaction !== "Recast") {
        throw new UsageError('reaction must be "Like" or "Recast"');
      }
      const reaction = body.reaction;
      const target = castId(body.target, "target");
      await write((w) => react(w, body.undo === true ? "remove" : "add", reaction, target));
      return { ok: true };
    },

    "POST /api/delete": async (_url, req) => {
      const target = castId((await readJson(req)).target, "target");
      await write((w) => deleteCast(w, target));
      return { deleted: target.hash };
    },

    "POST /api/follow": async (_url, req) => {
      const body = await readJson(req);
      const target = fidOf(body.fid, "fid");
      if (target === fid) throw new UsageError("you cannot follow yourself");
      await write((w) => follow(w, body.undo === true ? "remove" : "add", target));
      noteFollow(deps.dir, fid, target, body.undo !== true);
      return { ok: true };
    },
  };
  const { addKey } = deps;
  if (addKey) {
    const keys = keyFlow({ node: deps.node, config, confirm: deps.confirm, addKey });
    routes["POST /api/key/start"] = async (_url, req) => {
      await readJson(req);
      return keys.start();
    };
    routes["POST /api/key/finish"] = async (_url, req) => {
      const body = await readJson(req);
      const sigs = body.signatures as Partial<Record<"request" | "add", unknown>> | undefined;
      const isSig = (v: unknown): v is Hex =>
        typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v);
      if (typeof body.id !== "string" || !isSig(sigs?.request) || !isSig(sigs?.add)) {
        throw new UsageError("send the request id and the two 65-byte signatures as 0x hex");
      }
      try {
        return await keys.finish(body.id, { request: sigs.request, add: sigs.add });
      } finally {
        forget();
      }
    };
  } else {
    const readOnly: Route = async () => {
      throw new HttpError(403, "this page is read-only", READ_ONLY_HINT);
    };
    routes["POST /api/key/start"] = readOnly;
    routes["POST /api/key/finish"] = readOnly;
  }
  const push = deps.push;
  if (push) {
    routes["POST /api/push/subscribe"] = async (_url, req) => {
      const body = await readJson(req);
      let subscription: ReturnType<typeof parseSubscription>;
      try {
        subscription = parseSubscription(body);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      push.subscribe(subscription);
      return { ok: true };
    };
    routes["POST /api/push/unsubscribe"] = async (_url, req) => {
      push.unsubscribe(String((await readJson(req)).endpoint ?? ""));
      return { ok: true };
    };
  }
  return { routes, forget };
}
