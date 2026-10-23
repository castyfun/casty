import { ME_FID } from "@casty/mock-node";
import { describe, expect, it } from "vitest";
import { openIndex } from "../../src/local/store.js";
import { cast } from "../feed/helpers.js";

const me = ME_FID;
const other = me + 1;
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;

describe("the local index", () => {
  it("holds casts of you and your follows and lists them newest first, equal times by hash", async () => {
    const index = openIndex(":memory:");
    index.setFollow(me, other, true);
    index.upsert(cast(other, 10, "b"));
    index.upsert(cast(other, 10, "a"));
    index.upsert(cast(me, 5, "c"));
    index.upsert(cast(me + 2, 20, "d")); // a stranger: in the index, not in the feed
    const feed = await index.feed(me, { limit: 10, replies: true });
    expect(feed.map((c) => c.hash.slice(-1))).toEqual(["a", "b", "c"]);
    expect(index.follows(me)).toEqual([other]);
    index.setFollow(me, other, false);
    expect(
      (await index.feed(me, { limit: 10, replies: true })).map((c) => c.hash.slice(-1)),
    ).toEqual(["c"]);
    index.close();
  });

  it("applies the feed's filters: replies, since, channel, a limit, and an asynchronous admit", async () => {
    const index = openIndex(":memory:");
    index.upsert(cast(me, 1, "1"));
    index.upsert(
      cast(me, 2, "2", {
        castAddBody: {
          text: "r",
          mentions: [],
          mentionsPositions: [],
          embeds: [],
          parentCastId: { fid: me, hash: hash(1) },
        },
      }),
    );
    index.upsert(
      cast(me, 3, "3", {
        castAddBody: {
          text: "c",
          mentions: [],
          mentionsPositions: [],
          embeds: [],
          parentUrl: "https://example.com/~/channel/x",
        },
      }),
    );
    index.upsert(cast(me, 4, "4"));
    const hashes = async (options: Parameters<typeof index.feed>[1]) =>
      (await index.feed(me, options)).map((c) => c.hash.slice(-1));
    expect(await hashes({ limit: 10, replies: false })).toEqual(["4", "3", "1"]);
    expect(await hashes({ limit: 10, replies: true, since: 3 })).toEqual(["4", "3"]);
    expect(
      await hashes({ limit: 10, replies: true, channel: "https://example.com/~/channel/x" }),
    ).toEqual(["3"]);
    expect(await hashes({ limit: 2, replies: true })).toEqual(["4", "3"]);
    const odd = async (
      casts: Parameters<NonNullable<Parameters<typeof index.feed>[1]["admit"]>>[0],
    ) => casts.filter((c) => Number(c.hash.slice(-1)) % 2 === 1);
    expect(await hashes({ limit: 1, replies: true, admit: odd })).toEqual(["3"]);
    expect(await hashes({ limit: 5, replies: true, admit: odd })).toEqual(["3", "1"]);
    index.close();
  });

  it("upserts a cast once, removes it by hash, and keeps its mentions in step", () => {
    const index = openIndex(":memory:");
    const mentioning = cast(other, 7, "m", {
      castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
    });
    index.upsert(mentioning);
    index.upsert(mentioning);
    expect(index.mentions(me, 10).map((c) => c.hash)).toEqual([mentioning.hash]);
    index.remove(mentioning.hash, other);
    expect(index.mentions(me, 10)).toEqual([]);
    index.close();
  });

  it("lists mentions of you and replies to your casts, newest first, your own left out", () => {
    const index = openIndex(":memory:");
    index.upsert(cast(me, 1, "mine"));
    index.upsert(
      cast(other, 2, "reply", {
        castAddBody: {
          text: "r",
          mentions: [],
          mentionsPositions: [],
          embeds: [],
          parentCastId: { fid: me, hash: cast(me, 1, "mine").hash },
        },
      }),
    );
    index.upsert(
      cast(other, 3, "ment", {
        castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
      }),
    );
    index.upsert(
      cast(me, 4, "self", {
        castAddBody: { text: " me", mentions: [me], mentionsPositions: [0], embeds: [] },
      }),
    );
    expect(index.mentions(me, 10).map((c) => c.hash.slice(-4))).toEqual(["ment", "eply"]);
    expect(index.mentions(me, 1).map((c) => c.hash.slice(-4))).toEqual(["ment"]);
    index.close();
  });

  it("keeps your likes and recasts as the page's reacted sets", () => {
    const index = openIndex(":memory:");
    const target = { fid: other, hash: hash(9) };
    index.setReaction(me, "Like", target, true);
    index.setReaction(me, "Recast", target, true);
    index.setReaction(me, "Like", { fid: other, hash: hash(10) }, true);
    expect(index.reacted(me)).toEqual({
      likes: new Set([`${other}:${hash(9)}`, `${other}:${hash(10)}`]),
      recasts: new Set([`${other}:${hash(9)}`]),
    });
    index.setReaction(me, "Like", target, false);
    expect(index.reacted(me).likes).toEqual(new Set([`${other}:${hash(10)}`]));
    index.close();
  });

  it("remembers a cursor per shard with when it was moved, and when the first pass was done", () => {
    const index = openIndex(":memory:");
    expect(index.cursor(1)).toBeUndefined();
    expect(index.ready()).toBeUndefined();
    index.setCursor(1, 42, 1000);
    index.setCursor(1, 43, 2000);
    index.setCursor(2, 7, 2000);
    expect(index.cursor(1)).toEqual({ eventId: 43, at: 2000 });
    expect(index.cursor(2)).toEqual({ eventId: 7, at: 2000 });
    index.setReady(3000);
    expect(index.ready()).toBe(3000);
    index.close();
  });

  it("keeps everything in one file that opens again", async () => {
    const { tempDir } = await import("../tmp.js");
    const { join } = await import("node:path");
    const path = join(tempDir("casty-index-"), "index.sqlite");
    const first = openIndex(path);
    first.upsert(cast(me, 1, "kept"));
    first.close();
    const again = openIndex(path);
    expect(
      (await again.feed(me, { limit: 1, replies: true })).map((c) => c.hash.slice(-4)),
    ).toEqual(["kept"]);
    again.close();
  });
});

describe("what the index review found", () => {
  it("trims an account to its newest 100 casts, keeping what speaks to you, and drops an unfollowed one", () => {
    const index = openIndex(":memory:");
    index.setFollow(me, other, true);
    for (let i = 1; i <= 150; i++) index.upsert(cast(other, i, i.toString(16)));
    const mention = cast(other, 0, "aa", {
      castAddBody: { text: " hi", mentions: [me], mentionsPositions: [0], embeds: [] },
    });
    const reply = cast(other, 0, "bb", {
      castAddBody: {
        text: "r",
        mentions: [],
        mentionsPositions: [],
        embeds: [],
        parentCastId: { fid: me, hash: hash(1) },
      },
    });
    index.upsert(mention);
    index.upsert(reply);
    index.trim(other, 100, me);
    expect(index.count(other)).toBe(102);
    expect(index.mentions(me, 5).map((c) => c.hash)).toEqual([mention.hash, reply.hash].sort());
    index.setFollow(me, other, false);
    index.trim(other, 0, me);
    expect(index.count(other)).toBe(2);
    index.close();
  });

  it("pages an admitted feed by position, so a cast added meanwhile neither repeats nor hides one", async () => {
    const index = openIndex(":memory:");
    for (let i = 1; i <= 120; i++) index.upsert(cast(me, i, i.toString(16)));
    let pages = 0;
    const admit = async (casts: ReturnType<typeof cast>[]) => {
      // A poll lands a newer cast while the first page's signers are being looked up.
      if (pages++ === 0) index.upsert(cast(me, 500, "ff"));
      return casts.filter((c) => Number.parseInt(c.hash.slice(-2), 16) % 2 === 0);
    };
    const got = (await index.feed(me, { limit: 55, replies: true, admit })).map((c) => c.hash);
    expect(new Set(got).size).toBe(got.length);
    expect(got).toHaveLength(55);
    expect(got.map((h) => Number.parseInt(h.slice(-2), 16))).toEqual(
      [...Array(120).keys()]
        .map((i) => 120 - i)
        .filter((n) => n % 2 === 0)
        .slice(0, 55),
    );
    index.close();
  });

  it("reads the feed through the time index, without sorting every candidate", () => {
    const index = openIndex(":memory:");
    expect(index.feedPlan()).not.toMatch(/TEMP B-TREE/);
    index.close();
  });
});
