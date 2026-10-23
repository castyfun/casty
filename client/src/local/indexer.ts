import { CONCURRENCY, mapLimit, newestCasts } from "../feed/fanout.js";
import {
  allPages,
  type Hex,
  type HubEvent,
  type NodeClient,
  type NodeMessage,
} from "../node/http.js";
import type { LocalIndex } from "./store.js";

export interface IndexerOptions {
  /** Whose feed the index holds. */
  fid: number;
  /** How often the node's events are read (default 1.5 s). */
  pollMs?: number | undefined;
  /** Progress and trouble, one line at a time. */
  log?: ((text: string) => void) | undefined;
  /** Called from the live tail with a cast by someone else that mentions you or answers you. */
  onNotable?: ((cast: NodeMessage, kind: "mention" | "reply") => void) | undefined;
}

export interface Indexer {
  index: LocalIndex;
  /** Resolves once the index can answer: the first pass is done, or was done before. */
  started: Promise<void>;
  ready(): boolean;
  /**
   * Reads the events up to now, so a write just confirmed shows at once; nothing, at once,
   * while the first pass still runs.
   */
  catchUp(): Promise<void>;
  close(): void;
}

const POLL_MS = 1500;
const PAGE = 1000;
/** The node keeps three days of events; a cursor older than this cannot be caught up from. */
const STALE_MS = 2 * 86_400_000;
/** Casts kept per account: what the fan-out reads at most. */
const NEWEST = 100;
/** How many of your newest casts the first pass looks for replies to, as the mentions read does. */
const OWN_CASTS = 25;
/** How long to wait before trying a failed first pass again. */
const RETRY_MS = 10_000;
const KINDS = ["Like", "Recast"] as const;
const REACTION_KIND = { REACTION_TYPE_LIKE: "Like", REACTION_TYPE_RECAST: "Recast" } as const;

/** The shards that hold messages: every one the node reports but shard 0, which holds blocks. */
async function shardsOf(node: NodeClient): Promise<number[]> {
  const { info } = await node.info();
  const listed = info.shardInfos.map((s) => s.shardId).filter((id) => id !== 0);
  return listed.length > 0 ? listed : Array.from({ length: info.numShards }, (_, i) => i + 1);
}

/** The newest event id of a shard, so the first pass knows where the tail starts; 0 if none. */
async function headOf(node: NodeClient, shard: number): Promise<number> {
  const page = await node.events(shard, { from: 0, reverse: true, pageSize: 1 });
  return Number(page.items[0]?.id ?? 0);
}

/**
 * Fills the index from the node's stores: your follows, the newest 100 casts of you and each
 * of them, what others said to you, your likes and recasts. The event heads are read first, so
 * the tail from them covers anything merged while this ran.
 */
export async function bootstrap(node: NodeClient, index: LocalIndex, fid: number): Promise<void> {
  const shards = await shardsOf(node);
  const heads = await Promise.all(shards.map((shard) => headOf(node, shard)));
  const follows: number[] = [];
  for await (const link of allPages((pageToken) => node.linksByFid(fid, { pageToken }))) {
    const target = link.data.linkBody?.targetFid;
    if (target !== undefined) follows.push(target);
  }
  const wanted = new Set(follows);
  index.batch(() => {
    for (const target of index.follows(fid)) {
      if (!wanted.has(target)) {
        index.setFollow(fid, target, false);
        index.trim(target, 0, fid);
      }
    }
    for (const target of wanted) index.setFollow(fid, target, true);
  });
  await mapLimit([fid, ...wanted], CONCURRENCY, async (account) => {
    const casts = await newestCasts(node, account, NEWEST);
    // Over an index days old, a cast deleted meanwhile is in no event the tail can still read:
    // the account's casts are what the node lists now, plus whatever speaks to you.
    index.batch(() => {
      index.trim(account, 0, fid);
      for (const cast of casts) index.upsert(cast);
      index.trim(account, NEWEST, fid);
    });
  });
  const page = { reverse: true, pageSize: NEWEST };
  const [mentions, own] = await Promise.all([
    node.castsByMention(fid, page),
    node.castsByFid(fid, { reverse: true, pageSize: OWN_CASTS }),
  ]);
  const replies = await mapLimit(
    own.items,
    CONCURRENCY,
    async (cast) => (await node.castsByParent({ fid, hash: cast.hash }, page)).items,
  );
  index.batch(() => {
    for (const cast of [...mentions.items, ...replies.flat()]) index.upsert(cast);
  });
  for (const kind of KINDS) {
    const reactions: NodeMessage[] = [];
    for await (const r of allPages((pageToken) =>
      node.reactionsByFid(fid, kind, { pageToken, pageSize: PAGE }),
    )) {
      reactions.push(r);
    }
    // The same for a like or recast undone meanwhile: the node's list replaces the index's.
    const listed = new Set(reactions.map((r) => r.data.reactionBody?.targetCastId?.hash));
    const held = index.reacted(fid)[kind === "Like" ? "likes" : "recasts"];
    index.batch(() => {
      for (const hash of held) {
        if (!listed.has(hash as Hex))
          index.setReaction(fid, kind, { fid: 0, hash: hash as Hex }, false);
      }
      for (const r of reactions) {
        const target = r.data.reactionBody?.targetCastId;
        if (target) index.setReaction(fid, kind, target, true);
      }
    });
  }
  const now = Date.now();
  index.batch(() => {
    for (const [i, shard] of shards.entries()) index.setCursor(shard, heads[i] as number, now);
    index.setReady(now);
  });
}

/**
 * Keeps `index` current for `fid`: the first pass when there was none, or when the cursor is
 * too old for the node's three days of events to reach, then the events of every shard, read
 * every `pollMs`.
 */
export function startIndexer(
  node: NodeClient,
  index: LocalIndex,
  options: IndexerOptions,
): Indexer {
  const { fid } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const log = options.log ?? (() => {});
  let follows = new Set<number>();
  let shards: number[] = [];
  let closed = false;
  let bootstrapped = false;
  /** False during the first poll after a start: what it replays happened while this was off. */
  let live = false;
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined;
  /** Follows just made whose newest casts are still to be read; kept until a read succeeds. */
  const adopting = new Set<number>();

  /** What one event changes. `touched` collects the accounts whose casts it added. */
  function apply(event: HubEvent, touched: Set<number>): void {
    const merged = event.mergeMessageBody?.message;
    const removed = [
      ...(event.mergeMessageBody?.deletedMessages ?? []),
      event.pruneMessageBody?.message,
      event.revokeMessageBody?.message,
    ];
    for (const message of removed) if (message) undo(message);
    if (merged) take(merged, touched);
  }

  function take(message: NodeMessage, touched: Set<number>): void {
    const { data } = message;
    const body = data.castAddBody;
    switch (data.type) {
      case "MESSAGE_TYPE_CAST_ADD": {
        const toYou =
          data.fid === fid
            ? undefined
            : body?.parentCastId?.fid === fid
              ? "reply"
              : body?.mentions?.includes(fid)
                ? "mention"
                : undefined;
        if (data.fid === fid || follows.has(data.fid) || toYou) {
          index.upsert(message);
          touched.add(data.fid);
        }
        if (toYou && live) options.onNotable?.(message, toYou);
        break;
      }
      case "MESSAGE_TYPE_CAST_REMOVE":
        if (data.castRemoveBody) index.remove(data.castRemoveBody.targetHash, data.fid);
        break;
      case "MESSAGE_TYPE_LINK_ADD":
      case "MESSAGE_TYPE_LINK_REMOVE": {
        const target = data.linkBody?.targetFid;
        if (data.fid !== fid || data.linkBody?.type !== "follow" || target === undefined) break;
        const on = data.type === "MESSAGE_TYPE_LINK_ADD";
        index.setFollow(fid, target, on);
        if (on) {
          follows.add(target);
          adopting.add(target);
        } else {
          follows.delete(target);
          adopting.delete(target);
          index.trim(target, 0, fid);
        }
        break;
      }
      case "MESSAGE_TYPE_REACTION_ADD":
      case "MESSAGE_TYPE_REACTION_REMOVE": {
        const kind = REACTION_KIND[data.reactionBody?.type as keyof typeof REACTION_KIND];
        const target = data.reactionBody?.targetCastId;
        if (data.fid === fid && kind && target) {
          index.setReaction(fid, kind, target, data.type === "MESSAGE_TYPE_REACTION_ADD");
        }
        break;
      }
    }
  }

  /** A message the node dropped: a deleted cast, a removed reaction or follow, a pruned one. */
  function undo(message: NodeMessage): void {
    const { data } = message;
    if (data.type === "MESSAGE_TYPE_CAST_ADD") index.remove(message.hash, data.fid);
    else if (data.type === "MESSAGE_TYPE_LINK_ADD" || data.type === "MESSAGE_TYPE_REACTION_ADD") {
      take(
        { ...message, data: { ...data, type: data.type.replace("_ADD", "_REMOVE") } },
        new Set(),
      );
    }
  }

  /** The newest casts of the accounts just followed; one that fails stays to be read again. */
  async function adopt(): Promise<void> {
    await mapLimit([...adopting], CONCURRENCY, async (account) => {
      if (!follows.has(account)) {
        adopting.delete(account);
        return;
      }
      const casts = await newestCasts(node, account, NEWEST);
      index.batch(() => {
        for (const cast of casts) index.upsert(cast);
        index.trim(account, NEWEST, fid);
      });
      adopting.delete(account);
    });
  }

  async function poll(): Promise<void> {
    const oldest = Math.min(...shards.map((shard) => index.cursor(shard)?.at ?? 0));
    if (Date.now() - oldest > STALE_MS) {
      log(
        "index: the cursor is over two days old, past what the node keeps: reading everything again",
      );
      await bootstrap(node, index, fid);
      follows = new Set(index.follows(fid));
    }
    for (const shard of shards) {
      const from = (index.cursor(shard)?.eventId ?? 0) + 1;
      let cursor = from - 1;
      let token: string | undefined;
      do {
        const page = await node.events(shard, { from, pageSize: PAGE, pageToken: token });
        const touched = new Set<number>();
        // The page and the cursor past it land together, so a page is never applied twice.
        index.batch(() => {
          for (const event of page.items) {
            try {
              apply(event, touched);
            } catch (error) {
              // One event the index cannot take must not stop every one after it.
              log(
                `index: event ${event.id} skipped: ${error instanceof Error ? error.message : error}`,
              );
            }
            cursor = Math.max(cursor, Number(event.id));
          }
          for (const account of touched) index.trim(account, NEWEST, fid);
          index.setCursor(shard, cursor, Date.now());
        });
        token = page.nextPageToken || undefined;
      } while (token);
    }
    live = true;
    await adopt();
  }

  function schedule(): void {
    if (closed) return;
    timer = setTimeout(() => {
      catchUp()
        .catch((error: unknown) => log(`index: ${error instanceof Error ? error.message : error}`))
        .finally(schedule);
    }, pollMs);
  }

  const started = (async () => {
    while (!closed) {
      try {
        shards = await shardsOf(node);
        const oldest = Math.min(...shards.map((shard) => index.cursor(shard)?.at ?? 0));
        if (index.ready() === undefined || Date.now() - oldest > STALE_MS) {
          log("index: reading your follows and their newest casts");
          await bootstrap(node, index, fid);
          log("index: the first pass is done; the page reads from it now");
        }
        for (const shard of shards) {
          if ((index.cursor(shard)?.eventId ?? 0) === 0) {
            log(
              `index: shard ${shard} reports no events yet; its tail starts from the oldest kept`,
            );
          }
        }
        follows = new Set(index.follows(fid));
        bootstrapped = true;
        schedule();
        return;
      } catch (error) {
        if (closed) return;
        log(`index: ${error instanceof Error ? error.message : error}; trying again in 10 s`);
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RETRY_MS);
        });
      }
    }
  })();

  async function catchUp(): Promise<void> {
    if (!bootstrapped) return;
    // A poll under way may have read its page before the caller's write landed: it is let
    // finish, and a fresh one reads what came after.
    if (polling) await polling.catch(() => {});
    polling ??= poll().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  return {
    index,
    started,
    ready: () => index.ready() !== undefined,
    catchUp,
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
