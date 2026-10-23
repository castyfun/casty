import { APPS, FID_BASE, FIRST_AUTHOR, generateFixtures, ME_FID } from "@casty/mock-node";
import { describe, expect, it, vi } from "vitest";
import {
  CONCURRENCY,
  concurrencyOf,
  latestCasts,
  mapLimit,
  mergeNewest,
} from "../../src/feed/fanout.js";
import { loadFeed } from "../../src/feed/feed.js";
import { renderFeed } from "../../src/feed/render.js";
import { NodeError } from "../../src/node/errors.js";
import { type NodeClient, type NodeMessage, nodeClient } from "../../src/node/http.js";
import { farcasterNow } from "../../src/protocol/time.js";
import { startMock } from "../mock.js";
import { tempDir } from "../tmp.js";
import { cachedFixtures, random } from "./fixtures.js";
import { cast } from "./helpers.js";

const base = {
  fid: ME_FID,
  limit: 50,
  replies: true,
  onlyApps: [],
  excludeApps: [],
  refresh: false,
};

describe("CONCURRENCY", () => {
  it("is 64 unless CASTY_CONCURRENCY names another whole number from 1 to 256", () => {
    expect(CONCURRENCY).toBe(64);
    expect(concurrencyOf(undefined)).toBe(64);
    expect(concurrencyOf("32")).toBe(32);
    expect(concurrencyOf("1")).toBe(1);
    expect(concurrencyOf("256")).toBe(256);
    for (const bad of ["", " ", "0", "-1", "1.5", "lots", "257"]) {
      expect(concurrencyOf(bad), JSON.stringify(bad)).toBe(64);
    }
  });
});

describe("mapLimit", () => {
  it("runs at most `limit` tasks at once and keeps the input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("stops starting new tasks after one fails", async () => {
    const started: number[] = [];
    const run = mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      if (n === 2) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
    });
    await expect(run).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 30));
    expect(started.length).toBeLessThan(6);
  });
});

describe("mergeNewest", () => {
  it("orders by timestamp, newest first, ties broken by hash", () => {
    const merged = mergeNewest([
      [cast(FID_BASE + 1, 10, "b"), cast(FID_BASE + 1, 5, "c")],
      [cast(FID_BASE + 2, 10, "a"), cast(FID_BASE + 2, 7, "d")],
    ]);
    expect(merged.map((m) => m.hash.slice(-1))).toEqual(["a", "b", "d", "c"]);
  });
});

describe("latestCasts", () => {
  const stub = (fail: (fid: number) => NodeError | undefined) =>
    ({
      castsByFid: async (fid: number) => {
        const error = fail(fid);
        if (error) throw error;
        return { items: [cast(fid, fid - FID_BASE, String(fid))], nextPageToken: "" };
      },
    }) as unknown as NodeClient;

  it("skips fids the node does not know", async () => {
    const notFound = (fid: number) =>
      fid === 2 ? new NodeError("gone", { status: 404, errCode: "not_found" }) : undefined;
    expect((await latestCasts(stub(notFound), [1, 2, 3], 10)).map((m) => m.data.fid)).toEqual([
      3, 1,
    ]);
  });

  it("aborts on any other client error", async () => {
    const bad = (fid: number) =>
      fid === FID_BASE + 2 ? new NodeError("bad", { status: 400 }) : undefined;
    await expect(
      latestCasts(
        stub(bad),
        [1, 2, 3].map((n) => FID_BASE + n),
        10,
      ),
    ).rejects.toThrow("bad");
  });
});

/**
 * A node with a handful of accounts that post at very different rates, at times picked from 40
 * values so many are equal, sometimes answering with fewer casts than asked while it has more.
 */
function randomNode(next: () => number) {
  const lists = new Map<number, NodeMessage[]>();
  let n = 0;
  for (let fid = 1; fid <= 2 + Math.floor(next() * 12); fid++) {
    const list = Array.from({ length: Math.floor(next() ** 2 * 60) }, () => {
      const parent = next() < 0.3 ? { fid, hash: "0x00" as const } : undefined;
      const made = cast(fid, Math.floor(next() * 40), (n++).toString(16));
      if (parent && made.data.castAddBody) made.data.castAddBody.parentCastId = parent;
      return made;
    });
    // The node's order: newest first, equal times by hash.
    list.sort((a, b) => b.data.timestamp - a.data.timestamp || b.hash.localeCompare(a.hash));
    lists.set(fid, list);
  }
  const shortPages = next() < 0.5;
  const node = {
    castsByFid: async (fid: number, options: { pageSize?: number; pageToken?: string } = {}) => {
      const list = lists.get(fid) ?? [];
      const from = Number(options.pageToken || 0);
      const asked = options.pageSize ?? 100;
      const size = shortPages ? Math.max(1, Math.ceil(asked * (0.3 + next() * 0.7))) : asked;
      const items = list.slice(from, from + size);
      const end = from + items.length;
      return { items, nextPageToken: end < list.length ? String(end) : "" };
    },
  } as unknown as NodeClient;
  return { node, lists };
}

describe("latestCasts, reading short pages first", () => {
  /** What reading `limit` (at most 100) casts from every fid, then filtering, returns. */
  async function everything(api: NodeClient, fids: number[], limit: number, keep: Keep) {
    const pages = await Promise.all(
      fids.map(
        async (fid) =>
          (await api.castsByFid(fid, { reverse: true, pageSize: Math.min(limit, 100) })).items,
      ),
    );
    return mergeNewest(pages).filter(keep).slice(0, limit);
  }

  type Keep = (c: NodeMessage) => boolean;
  const hashes = (casts: NodeMessage[]) => casts.map((c) => c.hash);

  it("returns exactly the casts reading everything would, for any limit and filter", {
    timeout: 20_000,
  }, async () => {
    const fixtures = await cachedFixtures({ fids: 30, casts: 40, seed: 3 });
    const api = nodeClient((await startMock({ fixtures })).url);
    const times = fixtures.casts.map((c) => c.data.timestamp).sort((a, b) => a - b);
    const since = times[Math.floor(times.length * 0.8)] as number;
    const filters: [string, Keep, number | undefined][] = [
      ["all", () => true, undefined],
      ["no replies", (c) => !c.data.castAddBody?.parentCastId, undefined],
      ["since", (c) => c.data.timestamp >= since, since],
    ];
    for (const limit of [1, 7, 25, 60, 150]) {
      for (const [name, keep, from] of filters) {
        const want = await everything(api, fixtures.fids, limit, keep);
        const got = await latestCasts(api, fixtures.fids, limit, { keep, since: from });
        expect(hashes(got.slice(0, limit)), `${name}, limit ${limit}`).toEqual(hashes(want));
      }
    }
  });

  it("matches reading everything on random accounts: mixed rates, equal times, short pages", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const { node, lists } = randomNode(next);
      const fids = [...lists.keys()];
      const limit = 1 + Math.floor(next() * 130);
      const since = Math.floor(next() * 40);
      const filters: [string, Keep, number | undefined][] = [
        ["all", () => true, undefined],
        ["no replies", (c) => !c.data.castAddBody?.parentCastId, undefined],
        ["since", (c) => c.data.timestamp >= since, since],
      ];
      for (const [name, keep, from] of filters) {
        // The definition: the first min(limit, 100) casts of each account in the node's order.
        const want = mergeNewest([...lists.values()].map((l) => l.slice(0, Math.min(limit, 100))))
          .filter(keep)
          .slice(0, limit);
        const got = await latestCasts(node, fids, limit, { keep, since: from });
        expect(hashes(got.slice(0, limit)), `seed ${seed}, ${name}, limit ${limit}`).toEqual(
          hashes(want),
        );
      }
    }
  });

  it("returns nothing for a limit of 0", async () => {
    const { node, lists } = randomNode(random(1));
    expect(await latestCasts(node, [...lists.keys()], 0)).toEqual([]);
  });

  it("reads a fraction of what reading everything would", async () => {
    const fixtures = await generateFixtures({ fids: 30, casts: 40, seed: 3 });
    const api = nodeClient((await startMock({ fixtures })).url);
    let read = 0;
    const counting = {
      ...api,
      castsByFid: async (...args: Parameters<NodeClient["castsByFid"]>) => {
        const page = await api.castsByFid(...args);
        read += page.items.length;
        return page;
      },
    } as NodeClient;
    await latestCasts(counting, fixtures.fids, 40);
    expect(read).toBeLessThan((30 * 40) / 2);
  });

  /** An app filter's stand-in: decided per cast, asynchronously, as signer lookups are. */
  const halfAdmitted: Keep = (c) => Number.parseInt(c.hash.slice(-1), 16) % 2 === 0;
  const admit = async (casts: NodeMessage[]) => casts.filter(halfAdmitted);

  it("admits by an asynchronous filter as reading everything, then filtering, would", async () => {
    const fixtures = await cachedFixtures({ fids: 30, casts: 40, seed: 3 });
    const api = nodeClient((await startMock({ fixtures })).url);
    for (const limit of [1, 7, 25, 60, 150]) {
      const want = await everything(api, fixtures.fids, limit, halfAdmitted);
      const got = await latestCasts(api, fixtures.fids, limit, { admit });
      expect(hashes(got), `limit ${limit}`).toEqual(hashes(want));
    }
  });

  it("reads a fraction with an asynchronous filter too, as the app filters need", async () => {
    const fixtures = await cachedFixtures({ fids: 30, casts: 40, seed: 3 });
    const api = nodeClient((await startMock({ fixtures })).url);
    let read = 0;
    const counting = {
      ...api,
      castsByFid: async (...args: Parameters<NodeClient["castsByFid"]>) => {
        const page = await api.castsByFid(...args);
        read += page.items.length;
        return page;
      },
    } as NodeClient;
    await latestCasts(counting, fixtures.fids, 30, { admit });
    expect(read).toBeLessThan((30 * 30) / 2);
  });
});

describe("loadFeed", () => {
  it("reads a fraction of every account's casts with an app hidden too", async () => {
    const fixtures = await cachedFixtures({ fids: 30, casts: 40, seed: 3 });
    const api = nodeClient((await startMock({ fixtures })).url);
    let read = 0;
    const counting = {
      ...api,
      castsByFid: async (...args: Parameters<NodeClient["castsByFid"]>) => {
        const page = await api.castsByFid(...args);
        read += page.items.length;
        return page;
      },
    } as NodeClient;
    const items = await loadFeed(counting, {
      fids: fixtures.fids,
      limit: 30,
      replies: true,
      onlyApps: [],
      excludeApps: [String(APPS[0].fid)],
      refresh: false,
    });
    expect(items).toHaveLength(30);
    expect(items.every((item) => item.app?.fid !== APPS[0].fid)).toBe(true);
    expect(read).toBeLessThan((30 * 30) / 2);
  });

  it("returns the newest casts of everyone fid 1 follows, cut to the limit", async () => {
    const node = await startMock();
    const items = await loadFeed(nodeClient(node.url), { ...base, limit: 5 });
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.timestamp)).toEqual(
      items.map((i) => i.timestamp).toSorted((a, b) => b - a),
    );
    expect(items[0]?.author).toMatch(/^user-\d+$/);
  });

  it("leaves out a cast dated in the future: the protocol allows ten minutes of skew, no more", async () => {
    // A cast dated 2061 exists on mainnet; sorted by time it would sit on top for decades.
    const node = await startMock();
    const future = cast(FIRST_AUTHOR, farcasterNow() + 86_400 * 365, "f1");
    node.state.casts.push(future as never);
    const items = await loadFeed(nodeClient(node.url), { ...base, limit: 5 });
    expect(items.map((i) => i.hash)).not.toContain(future.hash);
  });

  it("names mentioned accounts and shows them in the rendered text", async () => {
    const node = await startMock();
    const items = await loadFeed(nodeClient(node.url), base);
    const mentioning = items.find((i) => i.mentions.length > 0);
    expect(mentioning?.mentions).toEqual([{ fid: ME_FID, position: 0, name: "casty-test" }]);
    expect(renderFeed(mentioning ? [mentioning] : [], 0, { width: 200, color: false })).toMatch(
      /\n {3}@casty-test \w/,
    );
  });

  it("names the author of the cast each reply answers", async () => {
    const node = await startMock();
    const reply = (await loadFeed(nodeClient(node.url), base)).find((i) => i.parent !== null);
    expect(reply?.parentAuthor).toBe(`user-${reply?.parent?.fid}`);
  });

  it("marks the casts signed with one of our own keys", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    const signer = (await loadFeed(api, base))[0]?.signer as string;
    const items = await loadFeed(api, { ...base, ownKeys: [signer] });
    expect(items.some((i) => i.ours)).toBe(true);
    expect(items.every((i) => i.ours === (i.signer === signer))).toBe(true);
  });

  it("reads an explicit --fids list without looking at follows", async () => {
    const node = await startMock();
    const items = await loadFeed(nodeClient(node.url), {
      ...base,
      fid: undefined,
      fids: [FIRST_AUTHOR],
    });
    expect(new Set(items.map((i) => i.fid))).toEqual(new Set([FIRST_AUTHOR]));
  });

  it("has up to 64 requests in flight, well past the 16 it once had", async () => {
    const node = await startMock({
      fixtures: await cachedFixtures({ fids: 100, casts: 2, seed: 7 }),
    });
    node.control({ latencyMs: 20 });
    await loadFeed(nodeClient(node.url), base);
    expect(node.state.stats.maxInFlight).toBeLessThanOrEqual(64);
    expect(node.state.stats.maxInFlight).toBeGreaterThan(16);
  });

  it("keeps to CASTY_CONCURRENCY requests in flight when it is set", async () => {
    const node = await startMock({
      fixtures: await cachedFixtures({ fids: 100, casts: 2, seed: 7 }),
    });
    node.control({ latencyMs: 20 });
    vi.stubEnv("CASTY_CONCURRENCY", "4");
    vi.resetModules();
    try {
      const feed = await import("../../src/feed/feed.js");
      await feed.loadFeed(nodeClient(node.url), base);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    expect(node.state.stats.maxInFlight).toBeLessThanOrEqual(4);
    expect(node.state.stats.maxInFlight).toBeGreaterThan(1);
  });

  it("reuses cached follows until --refresh", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    const cacheDir = tempDir("casty-feed-");
    expect((await loadFeed(api, { ...base, cacheDir })).length).toBeGreaterThan(0);
    node.state.links = node.state.links.filter((l) => l.data.fid !== ME_FID);
    expect((await loadFeed(api, { ...base, cacheDir })).length).toBeGreaterThan(0);
    expect(await loadFeed(api, { ...base, cacheDir, refresh: true })).toEqual([]);
  });

  // 300 follows x 50 casts, each request 30 ms away, as a node behind an SSH tunnel is: 64
  // requests at a time read 300 first pages in 5 round trips. Generating the fixtures takes a
  // few seconds, the feed must not.
  it.skipIf(Boolean(process.env.CI))(
    "serves a cold first page from 300 follows 30 ms away in under 500 ms",
    { timeout: 60_000 },
    async () => {
      const fixtures = await cachedFixtures({ fids: 300, casts: 50, seed: 42 });
      const node = await startMock({ fixtures });
      node.control({ latencyMs: 30 });
      const started = performance.now();
      const items = await loadFeed(nodeClient(node.url), base);
      expect(performance.now() - started).toBeLessThan(500);
      expect(items).toHaveLength(50);
    },
  );
});
