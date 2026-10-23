import { diskCache } from "../config.js";
import { ConfigError } from "../errors.js";
import type { LocalIndex } from "../local/store.js";
import type { CastId, NodeClient, NodeMessage } from "../node/http.js";
import { appLabeller, usernames } from "./clients.js";
import {
  CONCURRENCY,
  followedFids,
  latestCasts,
  mapLimit,
  mergeNewest,
  throttled,
} from "./fanout.js";
import { castFilter, matchesApp } from "./filters.js";
import { type FeedItem, toFeedItem } from "./render.js";

export interface FeedOptions {
  /** Whose feed: this fid and the accounts it follows; not needed with `fids`. */
  fid?: number | undefined;
  fids?: number[] | undefined;
  limit: number;
  replies: boolean;
  since?: number | undefined;
  channel?: string | undefined;
  onlyApps: string[];
  excludeApps: string[];
  refresh: boolean;
  cacheDir?: string | undefined;
  /** Caches to use instead of reading them from cacheDir: a long-running casty web keeps one. */
  caches?: FeedCaches | undefined;
  /** This casty's app keys (0x hex); casts signed with them are marked `ours`. */
  ownKeys?: string[] | undefined;
  /** casty serve's index of the feed: read from it instead of the node, except with `fids`. */
  index?: LocalIndex | undefined;
}

const MINUTE = 60_000;

export type FeedCaches = ReturnType<typeof feedCaches>;

/** The accounts each fid follows, kept 10 minutes; a follow or unfollow made here updates it. */
export const followsCache = (dir: string | undefined) =>
  diskCache<number[]>(dir, "follows", 10 * MINUTE);

/**
 * Puts a follow or unfollow made here into `fid`'s cached follow list, so the next feed has it
 * without reading the list again; with none cached, the next feed reads it from the node.
 */
export function noteFollow(
  dir: string | undefined,
  fid: number,
  target: number,
  on: boolean,
): void {
  const cache = followsCache(dir);
  const list = cache.get(String(fid));
  if (!list) return;
  cache.set(String(fid), on ? [...new Set([...list, target])] : list.filter((f) => f !== target));
  cache.save();
}

/** What describing casts reads: each author's keys to the apps behind them, and usernames. */
export function feedCaches(dir: string | undefined) {
  return {
    signers: diskCache<Record<string, number>>(dir, "signers", 60 * MINUTE),
    names: diskCache<string>(dir, "usernames", 24 * 60 * MINUTE),
  };
}

/**
 * You and your follows, newest casts of each, cheap filters, app labels and app filters, cut to
 * `limit`, then usernames of authors, mentions and the authors replies answer. Only the first
 * page of each author is read, so heavy filtering can return fewer than `limit` casts.
 */
export async function loadFeed(node: NodeClient, options: FeedOptions): Promise<FeedItem[]> {
  const caches = options.caches ?? feedCaches(options.cacheDir);
  let fids = options.fids && [...new Set(options.fids)];
  if (!fids && !options.index) {
    const fid = requireFid(options.fid);
    const follows = await followedFids(node, fid, followsCache(options.cacheDir), options.refresh);
    fids = [...new Set([fid, ...follows])];
  }
  fids ??= [];
  // Which casts pass the app filters is known only once their signers are looked up; the signer
  // cache answers the second look at the same casts.
  const shown = (item: FeedItem) =>
    (options.onlyApps.length === 0 || options.onlyApps.some((ref) => matchesApp(ref, item.app))) &&
    !options.excludeApps.some((ref) => matchesApp(ref, item.app));
  const admit = async (casts: NodeMessage[]) => {
    const items = await withApps(node, casts, caches);
    return casts.filter((_, i) => shown(items[i] as FeedItem));
  };
  const byApp = options.onlyApps.length > 0 || options.excludeApps.length > 0;
  const candidates =
    options.index && !options.fids
      ? await options.index.feed(requireFid(options.fid), {
          limit: options.limit,
          replies: options.replies,
          since: options.since,
          channel: options.channel,
          ...(byApp ? { admit } : {}),
        })
      : await latestCasts(node, fids, options.limit, {
          keep: castFilter(options),
          since: options.since,
          ...(byApp ? { admit } : {}),
        });
  return describe(node, candidates, caches, options.ownKeys);
}

export interface MentionsOptions {
  fid: number;
  limit: number;
  cacheDir?: string | undefined;
  caches?: FeedCaches | undefined;
  ownKeys?: string[] | undefined;
  index?: LocalIndex | undefined;
}

/** How many of your newest casts are checked for replies. */
const OWN_CASTS = 25;

/**
 * What others said to you: casts that mention you and replies to your newest casts, newest
 * first. ponytail: replies to casts older than your newest 25 are not looked for.
 */
export async function loadMentions(
  node: NodeClient,
  options: MentionsOptions,
): Promise<FeedItem[]> {
  return describeCasts(node, await mentionCasts(node, options), options);
}

/** The casts loadMentions lists, before their authors and apps are looked up. */
export async function mentionCasts(
  node: NodeClient,
  options: Pick<MentionsOptions, "fid" | "limit" | "index">,
): Promise<NodeMessage[]> {
  if (options.index) return options.index.mentions(options.fid, options.limit);
  const page = { reverse: true, pageSize: Math.min(options.limit, 100) };
  const [mentions, own] = await Promise.all([
    node.castsByMention(options.fid, page),
    node.castsByFid(options.fid, { reverse: true, pageSize: OWN_CASTS }),
  ]);
  const replies = await mapLimit(
    own.items,
    CONCURRENCY,
    async (cast) => (await node.castsByParent({ fid: cast.data.fid, hash: cast.hash }, page)).items,
  );
  // A reply that also mentions you comes back twice; it is listed once.
  const byHash = new Map(
    mergeNewest([mentions.items, ...replies])
      .filter((c) => c.data.fid !== options.fid)
      .map((c) => [c.hash, c]),
  );
  return [...byHash.values()].slice(0, options.limit);
}

export interface Thread<T> {
  parent: T | null;
  cast: T;
  replies: T[];
}

/**
 * A cast with the cast it answers and its replies, oldest first; undefined when its author has
 * no such cast. ponytail: the first 100 replies; page on when threads get longer.
 */
export async function readThread(
  node: NodeClient,
  id: CastId,
): Promise<Thread<NodeMessage> | undefined> {
  const cast = await node.castById(id.fid, id.hash);
  if (!cast) return undefined;
  const parentId = cast.data.castAddBody?.parentCastId;
  const [parent, replies] = await Promise.all([
    parentId ? node.castById(parentId.fid, parentId.hash) : undefined,
    node.castsByParent(id, { pageSize: 100 }),
  ]);
  // Sorted here: the order a node pages replies in is its index's, not necessarily time's.
  const oldest = [...replies.items].sort((a, b) => a.data.timestamp - b.data.timestamp);
  return { parent: parent ?? null, cast, replies: oldest };
}

/** A thread's casts in reading order: what it answers, the cast, then its replies. */
export const threadCasts = <T>(thread: Thread<T>): T[] => [
  ...(thread.parent ? [thread.parent] : []),
  thread.cast,
  ...thread.replies,
];

/** Casts read some other way (a thread, a single cast) described the way the feed is. */
export async function describeCasts(
  node: NodeClient,
  casts: NodeMessage[],
  options: Pick<FeedOptions, "cacheDir" | "caches" | "ownKeys">,
): Promise<FeedItem[]> {
  return describe(node, casts, options.caches ?? feedCaches(options.cacheDir), options.ownKeys);
}

async function withApps(node: NodeClient, casts: NodeMessage[], caches: FeedCaches) {
  const apps = await appLabeller(
    node,
    caches.signers,
  )(casts.map((c) => ({ fid: c.data.fid, signer: c.signer })));
  const appNames = await usernames(node, [...apps.values()], caches.names);
  return casts.map((cast) => {
    const app = apps.get(`${cast.data.fid}:${cast.signer}`);
    return {
      ...toFeedItem(cast),
      app: app === undefined ? null : { fid: app, name: appNames.get(app) ?? null },
    };
  });
}

/**
 * App labels and the names of authors, people mentioned and the authors replies answer. The two
 * lookups share nothing, so they run side by side: a cold feed waits for the longer, not both.
 */
async function describe(
  node: NodeClient,
  casts: NodeMessage[],
  caches: FeedCaches,
  ownKeys: string[] | undefined,
): Promise<FeedItem[]> {
  const people = casts
    .map(toFeedItem)
    .flatMap((i) => [i.fid, ...i.mentions.map((m) => m.fid), ...(i.parent ? [i.parent.fid] : [])]);
  const shared = throttled(node, CONCURRENCY);
  const [items, names] = await Promise.all([
    withApps(shared, casts, caches),
    usernames(shared, people, caches.names),
  ]);
  caches.signers.save();
  caches.names.save();
  const own = new Set(ownKeys);
  return items.map((item) => ({
    ...item,
    author: names.get(item.fid) ?? null,
    parentAuthor: item.parent ? (names.get(item.parent.fid) ?? null) : null,
    mentions: item.mentions.map((m) => ({ ...m, name: names.get(m.fid) ?? null })),
    ours: own.has(item.signer),
  }));
}

function requireFid(fid: number | undefined): number {
  if (fid === undefined)
    throw new ConfigError("no fid to read follows for", "run casty init, or pass --fids");
  return fid;
}
