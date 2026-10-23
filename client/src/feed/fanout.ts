import type { Cache } from "../config.js";
import { NodeError } from "../node/errors.js";
import {
  allPages,
  type NodeClient,
  type NodeMessage,
  type Page,
  type PageOptions,
} from "../node/http.js";
import { timely } from "../protocol/time.js";

const DEFAULT_CONCURRENCY = 64;

/**
 * How many requests to the node may be in flight at once: 64, or CASTY_CONCURRENCY when it
 * names a whole number from 1 to 256. A feed is bound by round trips, not by the node: 300
 * first pages 30 ms away take 5 of them at 64, 19 at 16. Lower it if a node answers 429 or 503.
 */
export function concurrencyOf(env: string | undefined): number {
  const n = Number(env);
  return env?.trim() && Number.isInteger(n) && n >= 1 && n <= 256 ? n : DEFAULT_CONCURRENCY;
}

export const CONCURRENCY = concurrencyOf(process.env.CASTY_CONCURRENCY);

/** Runs `fn` over `items` with at most `limit` calls in flight; stops starting calls after a failure. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * `node` with at most `limit` of its requests in flight at once, the rest queued: lookups that
 * run side by side, each with its own mapLimit, still share one budget.
 */
export function throttled(node: NodeClient, limit: number): NodeClient {
  let active = 0;
  const waiting: (() => void)[] = [];
  const call =
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await fn(...args);
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
  return Object.fromEntries(
    Object.entries(node).map(([name, fn]) => [
      name,
      // Each method passes its own arguments through unchanged.
      typeof fn === "function" ? call(fn as (...args: unknown[]) => Promise<unknown>) : fn,
    ]),
  ) as NodeClient;
}

/** Newest first, without casts dated in the future; equal timestamps ordered by hash so output is stable. */
export function mergeNewest(lists: NodeMessage[][]): NodeMessage[] {
  return lists
    .flat()
    .filter(timely)
    .sort((a, b) => b.data.timestamp - a.data.timestamp || a.hash.localeCompare(b.hash));
}

const isNotFound = (error: unknown) =>
  error instanceof NodeError && (error.status === 404 || error.errCode === "not_found");

export interface LatestOptions {
  /** Which casts count toward the limit; the rest are dropped. */
  keep?: (cast: NodeMessage) => boolean;
  /** Farcaster seconds: no cast older than this is kept, so no older page is needed. */
  since?: number | undefined;
  /**
   * Which of the casts `keep` passed count, decided asynchronously: the app filters, which need
   * each cast's signer looked up. It must judge each cast on its own, as `keep` does.
   */
  admit?: (casts: NodeMessage[]) => Promise<NodeMessage[]>;
}

/**
 * Casts asked of each fid first. A feed of 50 from hundreds of accounts takes a few from most of
 * them; an account that posts more than that gets a second page, one round trip later.
 */
const FIRST_PAGE = 5;
const MAX_PAGE = 100;

/**
 * The newest `limit` casts across `fids` that pass `keep`, newest first, as reading `limit` (at
 * most 100) from each fid would return them, from a fraction of the data: a page of 5 from
 * every fid, then the rest only from the fids whose page ends no older than the limit-th cast
 * kept so far, since only they can hold a newer one. Unknown fids are skipped.
 */
export async function latestCasts(
  node: NodeClient,
  fids: number[],
  limit: number,
  { keep = () => true, since, admit = async (casts) => casts }: LatestOptions = {},
): Promise<NodeMessage[]> {
  if (limit < 1) return [];
  const perFid = Math.min(limit, MAX_PAGE);
  const first = Math.min(perFid, FIRST_PAGE);
  const pages = await mapLimit(fids, CONCURRENCY, (fid) =>
    castPage(node, fid, { reverse: true, pageSize: first }),
  );
  const kept = async () =>
    (await admit(mergeNewest(pages.map((p) => p.items)).filter(keep))).slice(0, limit);

  const sofar = await kept();
  const cutoff = Math.max(
    sofar.length >= limit ? (sofar[limit - 1] as NodeMessage).data.timestamp : -Infinity,
    since ?? -Infinity,
  );
  const more = pages.flatMap((page, i) => {
    const oldest = page.items.at(-1);
    const hasMore = page.items.length < perFid && page.nextPageToken;
    return hasMore && oldest && oldest.data.timestamp >= cutoff ? [i] : [];
  });
  await mapLimit(more, CONCURRENCY, async (i) => {
    pages[i] = await readOn(node, fids[i] as number, pages[i] as Page<NodeMessage>, perFid);
  });
  return kept();
}

/** The newest `want` casts of one account, however short the node's pages come. */
export async function newestCasts(
  node: NodeClient,
  fid: number,
  want: number,
): Promise<NodeMessage[]> {
  const first = await castPage(node, fid, { reverse: true, pageSize: want });
  return (await readOn(node, fid, first, want)).items;
}

/**
 * The account's casts read on from `page` until there are `want` or no more. A node may answer
 * with fewer than asked; a cast seen twice, as when the casts shift between two reads, is kept
 * once.
 */
async function readOn(
  node: NodeClient,
  fid: number,
  page: Page<NodeMessage>,
  want: number,
): Promise<Page<NodeMessage>> {
  let { items, nextPageToken } = page;
  while (items.length < want && nextPageToken) {
    const rest = await castPage(node, fid, {
      reverse: true,
      pageSize: want - items.length,
      pageToken: nextPageToken,
    });
    const seen = new Set(items.map((c) => c.hash));
    items = [...items, ...rest.items.filter((c) => !seen.has(c.hash))];
    nextPageToken = rest.items.length > 0 ? rest.nextPageToken : "";
  }
  return { items, nextPageToken };
}

/** One page of a fid's casts; a fid the node does not know has none. */
async function castPage(
  node: NodeClient,
  fid: number,
  options: PageOptions,
): Promise<Page<NodeMessage>> {
  try {
    return await node.castsByFid(fid, options);
  } catch (error) {
    if (isNotFound(error)) return { items: [], nextPageToken: "" };
    throw error;
  }
}

export async function followedFids(
  node: NodeClient,
  fid: number,
  cache: Cache<number[]>,
  refresh: boolean,
): Promise<number[]> {
  const cached = refresh ? undefined : cache.get(String(fid));
  if (cached) return cached;
  const fids: number[] = [];
  for await (const link of allPages((pageToken) => node.linksByFid(fid, { pageToken }))) {
    const target = link.data.linkBody?.targetFid;
    if (target !== undefined) fids.push(target);
  }
  cache.set(String(fid), fids);
  cache.save();
  return fids;
}
