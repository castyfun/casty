import { FIRST_AUTHOR, FIXTURE_TIME, type Fixtures, fixtureKey, ME_FID } from "@casty/mock-node";
import { Message, NobleEd25519Signer } from "@farcaster/core";
import { describe, expect, it, vi } from "vitest";
import { latestCasts, mergeNewest } from "../../src/feed/fanout.js";
import { mentionCasts } from "../../src/feed/feed.js";
import { bootstrap, startIndexer } from "../../src/local/indexer.js";
import { openIndex } from "../../src/local/store.js";
import { NodeError } from "../../src/node/errors.js";
import { type NodeClient, type NodeMessage, nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { farcasterNow } from "../../src/protocol/time.js";
import { cachedFixtures, random } from "../feed/fixtures.js";
import { cast } from "../feed/helpers.js";
import { startMock } from "../mock.js";

const me = ME_FID;
const hashes = (casts: NodeMessage[]) => casts.map((c) => c.hash);
type Keep = (c: NodeMessage) => boolean;

/** An indexer over `fixtures` on a fresh mock, with its first pass done. */
async function indexed(fixtures: Fixtures, pollMs?: number) {
  const node = await startMock({ fixtures });
  const api = nodeClient(node.url);
  const index = openIndex(":memory:");
  const indexer = startIndexer(api, index, { fid: me, ...(pollMs ? { pollMs } : {}) });
  await indexer.started;
  return { node, api, index, indexer };
}

describe("a first pass over an index days old", () => {
  // casty serve was off for longer than the node keeps events: what was deleted or unliked
  // meanwhile is in no event it can read, so the pass itself must drop it.
  it("drops casts the node no longer has and likes it no longer lists", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    const index = openIndex(":memory:");
    await bootstrap(api, index, me);
    const gone = cast(FIRST_AUTHOR, farcasterNow() - 5, "ee".repeat(20));
    index.upsert(gone);
    index.setReaction(me, "Like", { fid: FIRST_AUTHOR, hash: `0x${"dd".repeat(20)}` }, true);
    await bootstrap(api, index, me);
    expect(hashes(await index.feed(me, { limit: 100, replies: true }))).not.toContain(gone.hash);
    expect(index.reacted(me).likes.has(`0x${"dd".repeat(20)}`)).toBe(false);
  });
});

describe("the first pass", () => {
  it("fills the index so the feed equals the fan-out's, reading 100 casts an account, for every limit and filter", {
    timeout: 60_000,
  }, async () => {
    for (const seed of [3, 4]) {
      const fixtures = await cachedFixtures({ fids: 30, casts: 40, seed });
      const { api, index, indexer } = await indexed(fixtures);
      const fids = [me, ...fixtures.fids];
      const times = fixtures.casts.map((c) => c.data.timestamp).sort((a, b) => a - b);
      const since = times[Math.floor(times.length * 0.8)] as number;
      const filters: [string, Keep, number | undefined][] = [
        ["all", () => true, undefined],
        ["no replies", (c) => !c.data.castAddBody?.parentCastId, undefined],
        ["since", (c) => c.data.timestamp >= since, since],
      ];
      for (const limit of [1, 7, 25, 60]) {
        for (const [name, keep, from] of filters) {
          const want = (await latestCasts(api, fids, 100, { keep, since: from })).slice(0, limit);
          const got = await index.feed(me, { limit, replies: name !== "no replies", since: from });
          expect(hashes(got), `seed ${seed}, ${name}, limit ${limit}`).toEqual(hashes(want));
        }
      }
      const odd = async (casts: NodeMessage[]) =>
        casts.filter((c) => Number.parseInt(c.hash.slice(-1), 16) % 2 === 1);
      const want = (await latestCasts(api, fids, 100, { admit: odd })).slice(0, 20);
      expect(hashes(await index.feed(me, { limit: 20, replies: true, admit: odd }))).toEqual(
        hashes(want),
      );
      indexer.close();
    }
  });

  it("matches the fan-out on random accounts: mixed rates, equal times, short pages", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const next = random(seed);
      const { node, lists } = randomNode(next);
      const index = openIndex(":memory:");
      await bootstrap(node, index, me);
      const limit = 1 + Math.floor(next() * 130);
      const since = Math.floor(next() * 40);
      const filters: [string, Keep, number | undefined][] = [
        ["all", () => true, undefined],
        ["no replies", (c) => !c.data.castAddBody?.parentCastId, undefined],
        ["since", (c) => c.data.timestamp >= since, since],
      ];
      for (const [name, keep, from] of filters) {
        const want = mergeNewest([...lists.values()].map((l) => l.slice(0, 100)))
          .filter(keep)
          .slice(0, limit);
        const got = await index.feed(me, { limit, replies: name !== "no replies", since: from });
        expect(hashes(got), `seed ${seed}, ${name}, limit ${limit}`).toEqual(hashes(want));
      }
      index.close();
    }
  });

  it("holds what others said to you, as the mentions read does", async () => {
    const { api, index, indexer } = await indexed(
      await cachedFixtures({ fids: 30, casts: 40, seed: 3 }),
    );
    const want = await mentionCasts(api, { fid: me, limit: 30 });
    expect(want.length).toBeGreaterThan(0);
    expect(hashes(index.mentions(me, 30))).toEqual(hashes(want));
    indexer.close();
  });

  it.skipIf(!process.env.CASTY_TIMING)(
    "answers a feed of 300 follows in under 20 ms",
    { timeout: 60_000 },
    async () => {
      const { index, indexer } = await indexed(
        await cachedFixtures({ fids: 300, casts: 50, seed: 42 }),
      );
      const started = performance.now();
      const items = await index.feed(me, { limit: 50, replies: true });
      expect(performance.now() - started).toBeLessThan(20);
      expect(items).toHaveLength(50);
      indexer.close();
    },
  );

  it("is done again when the cursor is older than two days, since the node keeps three days of events", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const { node, api, index, indexer } = await indexed(fixtures);
    const first = index.ready() as number;
    indexer.close();
    index.setCursor(1, 0, Date.now() - 3 * 86_400_000);
    const stale = startIndexer(api, index, { fid: me });
    await stale.started;
    expect(index.ready()).toBeGreaterThan(first);
    stale.close();
    // Fresh enough: no second pass.
    index.setCursor(1, (index.cursor(1) as { eventId: number }).eventId, Date.now() - 86_400_000);
    const before = index.ready();
    const fresh = startIndexer(api, index, { fid: me });
    await fresh.started;
    expect(index.ready()).toBe(before);
    fresh.close();
    expect(node.state.casts.length).toBeGreaterThan(0);
  });
});

describe("the tail", () => {
  // The fixtures of these tests are generated with seed 9, and so are their authors' keys.
  const signer = new NobleEd25519Signer(fixtureKey(9, FIRST_AUTHOR));

  it("has a new cast by an account you follow within 5 s, at the default pace", {
    timeout: 10_000,
  }, async () => {
    const { node, api, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
    );
    const made = await buildCast(FIRST_AUTHOR, { text: "fresh" }, signer);
    await api.submitMessage(Message.encode(made).finish());
    const started = performance.now();
    await vi.waitFor(
      async () =>
        expect((await index.feed(me, { limit: 1, replies: true }))[0]?.data.castAddBody?.text).toBe(
          "fresh",
        ),
      { timeout: 5000, interval: 50 },
    );
    expect(performance.now() - started).toBeLessThan(5000);
    expect(node.state.events.length).toBeGreaterThan(0);
    indexer.close();
  });

  it("keeps a stranger's cast only when it mentions you or answers you, and drops a removed cast", async () => {
    const { node, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const stranger = me + 7000;
    // Hashes are hex on the wire: the mock decodes them, so the stand-ins must be hex too; and
    // newer than every fixture cast, so they come first.
    const t = FIXTURE_TIME + 1000;
    const mine = cast(me, t, "e0");
    const plain = cast(stranger, t + 1, "a0");
    const mention = cast(stranger, t + 2, "a1", {
      castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
    });
    const reply = cast(stranger, t + 3, "a2", {
      castAddBody: {
        text: "r",
        mentions: [],
        mentionsPositions: [],
        embeds: [],
        parentCastId: { fid: me, hash: mine.hash },
      },
    });
    node.control({ emitEvents: [mine, plain, mention, reply] });
    await indexer.catchUp();
    expect(hashes(index.mentions(me, 10)).slice(0, 2)).toEqual([reply.hash, mention.hash]);
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(plain.hash);
    const remove = cast(stranger, t + 4, "a3", {
      type: "MESSAGE_TYPE_CAST_REMOVE",
      castRemoveBody: { targetHash: mention.hash },
    });
    (remove.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [remove] });
    await indexer.catchUp();
    expect(hashes(index.mentions(me, 10))).not.toContain(mention.hash);
    indexer.close();
  });

  it("drops a cast dated in the future: the protocol allows ten minutes of skew, no more", async () => {
    const { node, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const future = cast(FIRST_AUTHOR, farcasterNow() + 86_400 * 365, "f1");
    node.control({ emitEvents: [future] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(future.hash);
    indexer.close();
  });

  it("follows a follow: a new follow's newest casts come in, an unfollow's go out", async () => {
    const { node, api, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const newcomer = me + 8000;
    const old = cast(newcomer, 601, "b2");
    node.control({ emitEvents: [cast(newcomer, 600, "b1"), old] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(old.hash);
    const follow = cast(me, 602, "c1", {
      type: "MESSAGE_TYPE_LINK_ADD",
      linkBody: { type: "follow", targetFid: newcomer },
    });
    (follow.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [follow] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).toContain(old.hash);
    expect(index.follows(me)).toContain(newcomer);
    const unfollow = {
      ...follow,
      hash: cast(me, 603, "c2").hash,
      data: { ...follow.data, type: "MESSAGE_TYPE_LINK_REMOVE", timestamp: 603 },
    };
    node.control({ emitEvents: [unfollow] });
    await indexer.catchUp();
    expect(index.follows(me)).not.toContain(newcomer);
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(old.hash);
    expect(api.url).toBe(node.url);
    indexer.close();
  });

  it("keeps your likes current from the events", async () => {
    const { node, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const target = { fid: FIRST_AUTHOR, hash: `0x${"cd".repeat(20)}` as const };
    const like = cast(me, 700, "d1", {
      type: "MESSAGE_TYPE_REACTION_ADD",
      reactionBody: { type: "REACTION_TYPE_LIKE", targetCastId: target },
    });
    (like.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [like] });
    await indexer.catchUp();
    expect(index.reacted(me).likes).toContain(`${target.fid}:${target.hash}`);
    const unlike = {
      ...like,
      hash: cast(me, 701, "d2").hash,
      data: { ...like.data, type: "MESSAGE_TYPE_REACTION_REMOVE", timestamp: 701 },
    };
    node.control({ emitEvents: [unlike] });
    await indexer.catchUp();
    expect(index.reacted(me).likes).not.toContain(`${target.fid}:${target.hash}`);
    indexer.close();
  });

  it("moves the cursor past what it read, so a restart goes on from there", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const { node, api, index, indexer } = await indexed(fixtures, 20);
    const made = await buildCast(FIRST_AUTHOR, { text: "before the restart" }, signer);
    await api.submitMessage(Message.encode(made).finish());
    await indexer.catchUp();
    const at = index.cursor(1);
    expect(at?.eventId).toBe(node.state.events.length);
    indexer.close();
    const again = startIndexer(api, index, { fid: me, pollMs: 20 });
    await again.started;
    const later = await buildCast(FIRST_AUTHOR, { text: "after the restart" }, signer);
    await api.submitMessage(Message.encode(later).finish());
    await again.catchUp();
    // Both casts may fall in the same Farcaster second, and then order by hash.
    const newest = (await index.feed(me, { limit: 2, replies: true })).map(
      (c) => c.data.castAddBody?.text,
    );
    expect(newest).toContain("after the restart");
    expect(index.cursor(1)?.eventId).toBe(node.state.events.length);
    again.close();
  });
});

/**
 * A node of a few accounts that you follow, posting at very different rates, with equal times
 * and sometimes short pages; nothing else to read, and no shards to tail.
 */
function randomNode(next: () => number) {
  const lists = new Map<number, NodeMessage[]>();
  let n = 0;
  for (let fid = me + 1; fid <= me + 2 + Math.floor(next() * 12); fid++) {
    const list = Array.from({ length: Math.floor(next() ** 2 * 60) }, () => {
      const parent = next() < 0.3 ? { fid, hash: "0x00" as const } : undefined;
      const made = cast(fid, Math.floor(next() * 40), (n++).toString(16));
      if (parent && made.data.castAddBody) made.data.castAddBody.parentCastId = parent;
      return made;
    });
    list.sort((a, b) => b.data.timestamp - a.data.timestamp || b.hash.localeCompare(a.hash));
    lists.set(fid, list);
  }
  const shortPages = next() < 0.5;
  const empty = async () => ({ items: [], nextPageToken: "" });
  const node = {
    url: "stub",
    info: async () => ({
      info: {
        version: "stub",
        numShards: 0,
        shardInfos: [],
        dbStats: { numMessages: 0, numFidRegistrations: 0, approxSize: 0 },
      },
      date: undefined,
    }),
    linksByFid: async () => ({
      items: [...lists.keys()].map((fid) =>
        cast(me, 1, `l${fid}`, {
          type: "MESSAGE_TYPE_LINK_ADD",
          linkBody: { type: "follow", targetFid: fid },
        }),
      ),
      nextPageToken: "",
    }),
    castsByFid: async (fid: number, options: { pageSize?: number; pageToken?: string } = {}) => {
      const list = lists.get(fid) ?? [];
      const from = Number(options.pageToken || 0);
      const asked = options.pageSize ?? 100;
      const size = shortPages ? Math.max(1, Math.ceil(asked * (0.3 + next() * 0.7))) : asked;
      const items = list.slice(from, from + size);
      const end = from + items.length;
      return { items, nextPageToken: end < list.length ? String(end) : "" };
    },
    castsByMention: empty,
    castsByParent: empty,
    reactionsByFid: empty,
    events: empty,
  } as unknown as NodeClient;
  return { node, lists };
}

describe("what the tail tells push", () => {
  it("names a mention that arrives live, not the ones replayed after a restart", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const { node, api, index, indexer } = await indexed(fixtures, 20);
    indexer.close();
    const stranger = me + 7100;
    const t = FIXTURE_TIME + 200_000;
    const mention = (n: number) =>
      cast(stranger, t + n, `f${n}`, {
        castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
      });
    // Two mentions while the service was off: on the node, behind the cursor.
    node.control({ emitEvents: [mention(1), mention(2)] });
    const told: string[] = [];
    const again = startIndexer(api, index, {
      fid: me,
      pollMs: 20,
      onNotable: (c, kind) => told.push(`${kind} ${c.hash.slice(-2)}`),
    });
    await again.started;
    await again.catchUp();
    expect(hashes(index.mentions(me, 10))).toContain(mention(2).hash);
    expect(told).toEqual([]);
    node.control({ emitEvents: [mention(3)] });
    await again.catchUp();
    expect(told).toEqual(["mention f3"]);
    again.close();
  });
});

describe("what the index review found", () => {
  const follow = (n: number, t: number) => cast(FIRST_AUTHOR, t, `e${n}`);

  it("drops a cast on its author's CAST_REMOVE only, never on a stranger's naming it", async () => {
    const { node, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const t = FIXTURE_TIME + 300_000;
    const kept = follow(1, t);
    node.control({ emitEvents: [kept] });
    await indexer.catchUp();
    const stranger = me + 7200;
    const forged = cast(stranger, t + 1, "e2", {
      type: "MESSAGE_TYPE_CAST_REMOVE",
      castRemoveBody: { targetHash: kept.hash },
    });
    (forged.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [forged] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).toContain(kept.hash);
    const own = cast(FIRST_AUTHOR, t + 2, "e3", {
      type: "MESSAGE_TYPE_CAST_REMOVE",
      castRemoveBody: { targetHash: kept.hash },
    });
    (own.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [own] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(kept.hash);
    indexer.close();
  });

  it("tells push once about a page whose new follow could not be read, and reads the follow next time", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const node = await startMock({ fixtures });
    const api = nodeClient(node.url);
    const newcomer = me + 8100;
    let failures = 0;
    const flaky = {
      ...api,
      castsByFid: (fid: number, options?: Parameters<typeof api.castsByFid>[1]) => {
        if (fid === newcomer && failures++ === 0) {
          return Promise.reject(new NodeError("the node is too busy", { status: 503 }));
        }
        return api.castsByFid(fid, options);
      },
    } as NodeClient;
    const index = openIndex(":memory:");
    const told: string[] = [];
    const indexer = startIndexer(flaky, index, {
      fid: me,
      pollMs: 20,
      onNotable: (c) => told.push(c.hash),
    });
    await indexer.started;
    await indexer.catchUp();
    const t = FIXTURE_TIME + 310_000;
    const old = cast(newcomer, t, "a7");
    const mention = cast(me + 7300, t + 1, "a8", {
      castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
    });
    const link = cast(me, t + 2, "a9", {
      type: "MESSAGE_TYPE_LINK_ADD",
      linkBody: { type: "follow", targetFid: newcomer },
    });
    (link.data as { castAddBody?: unknown }).castAddBody = undefined;
    node.control({ emitEvents: [old, mention, link] });
    await expect(indexer.catchUp()).rejects.toThrow("too busy");
    await indexer.catchUp();
    expect(told).toEqual([mention.hash]);
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).toContain(old.hash);
    indexer.close();
  });

  it("does the first pass again when a poll finds the cursor two days old", async () => {
    const { index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const first = index.ready() as number;
    index.setCursor(
      1,
      (index.cursor(1) as { eventId: number }).eventId,
      Date.now() - 3 * 86_400_000,
    );
    await indexer.catchUp();
    expect(index.ready()).toBeGreaterThan(first);
    indexer.close();
  });

  it("goes on past a cast the node prints without a text", async () => {
    const { node, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const t = FIXTURE_TIME + 320_000;
    const bare = cast(FIRST_AUTHOR, t, "b7");
    (bare.data.castAddBody as { text?: string }).text = "";
    const after = follow(8, t + 1);
    node.control({ emitEvents: [bare, after] });
    await indexer.catchUp();
    const feed = await index.feed(me, { limit: 5, replies: true });
    expect(hashes(feed)).toEqual(expect.arrayContaining([bare.hash, after.hash]));
    expect(feed.find((c) => c.hash === bare.hash)?.data.castAddBody?.text ?? "").toBe("");
    indexer.close();
  });

  it("follows the page token when the node answers in short pages", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const node = await startMock({ fixtures });
    const api = nodeClient(node.url);
    const short = {
      ...api,
      events: (shard: number, o: Parameters<typeof api.events>[1] = {}) =>
        api.events(shard, { ...o, pageSize: 1 }),
    } as NodeClient;
    const index = openIndex(":memory:");
    const indexer = startIndexer(short, index, { fid: me, pollMs: 20 });
    await indexer.started;
    const t = FIXTURE_TIME + 330_000;
    node.control({ emitEvents: [follow(11, t), follow(12, t + 1), follow(13, t + 2)] });
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 3, replies: true }))).toEqual([
      follow(13, t + 2).hash,
      follow(12, t + 1).hash,
      follow(11, t).hash,
    ]);
    indexer.close();
  });

  it("answers catchUp at once while the first pass is still running, so a write never waits for it", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const node = await startMock({ fixtures });
    const api = nodeClient(node.url);
    const stuck = { ...api, info: () => new Promise<never>(() => {}) } as NodeClient;
    const index = openIndex(":memory:");
    const indexer = startIndexer(stuck, index, { fid: me, pollMs: 20 });
    const started = performance.now();
    await indexer.catchUp();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(indexer.ready()).toBe(false);
    indexer.close();
  });

  it("keeps you liked when a like is sent again, through the deleted message in its event", async () => {
    const { node, api, index, indexer } = await indexed(
      await cachedFixtures({ fids: 5, casts: 3, seed: 9 }),
      20,
    );
    const target = (await api.castsByFid(FIRST_AUTHOR, { reverse: true, pageSize: 1 }))
      .items[0] as NodeMessage;
    const like = (n: number) => {
      const m = cast(me, FIXTURE_TIME + 340_000 + n, `c${n}`, {
        type: "MESSAGE_TYPE_REACTION_ADD",
        reactionBody: {
          type: "REACTION_TYPE_LIKE",
          targetCastId: { fid: target.data.fid, hash: target.hash },
        },
      });
      (m.data as { castAddBody?: unknown }).castAddBody = undefined;
      return m;
    };
    node.control({ emitEvents: [like(1)] });
    await indexer.catchUp();
    node.control({ emitEvents: [like(2)] });
    await indexer.catchUp();
    const event = node.state.events.at(-1);
    expect(event?.mergeMessageBody.deletedMessages.map((m) => m.hash)).toEqual([like(1).hash]);
    expect(index.reacted(me).likes).toContain(`${target.data.fid}:${target.hash}`);
    indexer.close();
  });
});

describe("what the node prunes or revokes", () => {
  it("goes out of the index, as a deleted message does", async () => {
    const fixtures = await cachedFixtures({ fids: 5, casts: 3, seed: 9 });
    const node = await startMock({ fixtures });
    const api = nodeClient(node.url);
    const victim = (await api.castsByFid(FIRST_AUTHOR, { reverse: true, pageSize: 1 }))
      .items[0] as NodeMessage;
    // The mock emits no prune or revoke events; one of each is put after the node's own.
    let extra = 0;
    const pruning = {
      ...api,
      events: async (shard: number, options: Parameters<typeof api.events>[1] = {}) => {
        const page = await api.events(shard, options);
        if (shard !== 1 || extra > 0 || (options.from ?? 0) === 0) return page;
        extra++;
        const id = Number(page.items.at(-1)?.id ?? options.from ?? 0) + 1;
        return {
          ...page,
          items: [
            ...page.items,
            {
              type: "HUB_EVENT_TYPE_PRUNE_MESSAGE",
              id,
              shardIndex: 1,
              pruneMessageBody: { message: victim },
            },
          ],
        };
      },
    } as NodeClient;
    const index = openIndex(":memory:");
    const indexer = startIndexer(pruning, index, { fid: me, pollMs: 20 });
    await indexer.started;
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).toContain(victim.hash);
    await indexer.catchUp();
    expect(hashes(await index.feed(me, { limit: 50, replies: true }))).not.toContain(victim.hash);
    indexer.close();
  });
});
