import { APPS, CHANNEL_URL, FID_BASE, FIXTURE_TIME, ME_FID } from "@casty/mock-node";
import { describe, expect, it } from "vitest";
import { loadFeed } from "../../src/feed/feed.js";
import { castFilter, matchesApp } from "../../src/feed/filters.js";
import { nodeClient } from "../../src/node/http.js";
import { startMock } from "../mock.js";
import { cast } from "./helpers.js";

const base = {
  fid: ME_FID,
  limit: 50,
  replies: true,
  onlyApps: [],
  excludeApps: [],
  refresh: false,
};
const reply = cast(FID_BASE + 1, 100, "r", {
  castAddBody: {
    text: "re",
    parentCastId: { fid: FID_BASE + 2, hash: `0x${"aa".repeat(20)}` },
    mentions: [],
    mentionsPositions: [],
    embeds: [],
  },
});
const channelPost = cast(FID_BASE + 1, 50, "c", {
  castAddBody: {
    text: "hi",
    parentUrl: CHANNEL_URL,
    mentions: [],
    mentionsPositions: [],
    embeds: [],
  },
});
const plain = cast(FID_BASE + 1, 10, "p");

describe("castFilter", () => {
  it("keeps everything by default", () => {
    expect([reply, channelPost, plain].filter(castFilter({ replies: true }))).toHaveLength(3);
  });

  it("drops replies with --no-replies", () => {
    expect([reply, channelPost, plain].filter(castFilter({ replies: false }))).toEqual([
      channelPost,
      plain,
    ]);
  });

  it("drops casts older than --since", () => {
    expect([reply, channelPost, plain].filter(castFilter({ replies: true, since: 50 }))).toEqual([
      reply,
      channelPost,
    ]);
  });

  it("keeps only one channel with --channel", () => {
    expect(
      [reply, channelPost, plain].filter(castFilter({ replies: true, channel: CHANNEL_URL })),
    ).toEqual([channelPost]);
  });
});

describe("matchesApp", () => {
  const app = { fid: APPS[0].fid, name: "app-alpha" };
  it.each(["app-alpha", "@app-alpha", String(APPS[0].fid)])("matches %s", (ref) => {
    expect(matchesApp(ref, app)).toBe(true);
  });
  it("does not match another app or a missing label", () => {
    expect(matchesApp("app-beta", app)).toBe(false);
    expect(matchesApp("app-alpha", null)).toBe(false);
  });
});

describe("app filters on the feed", () => {
  const alpha = APPS[0];

  it("--only-app keeps casts whose key app-alpha requested", async () => {
    const node = await startMock();
    const items = await loadFeed(nodeClient(node.url), { ...base, onlyApps: [alpha.name] });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.app?.fid === alpha.fid && i.app.name === alpha.name)).toBe(true);
  });

  it("--exclude-app drops them", async () => {
    const node = await startMock();
    const items = await loadFeed(nodeClient(node.url), {
      ...base,
      excludeApps: [String(alpha.fid)],
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.app?.fid === alpha.fid)).toBe(false);
  });

  it("--no-replies, --since and --channel work against the node", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    expect((await loadFeed(api, { ...base, replies: false })).every((i) => !i.parent)).toBe(true);
    const recent = await loadFeed(api, { ...base, since: FIXTURE_TIME - 1300 });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((i) => i.timestamp >= FIXTURE_TIME - 1300)).toBe(true);
    const channel = await loadFeed(api, { ...base, channel: CHANNEL_URL });
    expect(channel.length).toBeGreaterThan(0);
    expect(channel.every((i) => i.channel === CHANNEL_URL)).toBe(true);
  });
});
