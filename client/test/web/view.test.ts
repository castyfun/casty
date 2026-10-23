import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../src/feed/render.js";
import { segments, toWebCast } from "../../src/web/view.js";

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  fid: 7,
  hash: `0x${"ab".repeat(20)}`,
  timestamp: 1000,
  time: "2021-01-01T00:16:40.000Z",
  author: "alice",
  app: { fid: 9, name: "app-alpha" },
  text: "hello",
  parent: null,
  parentAuthor: null,
  channel: null,
  embeds: [],
  mentions: [],
  signer: "0x01",
  ours: false,
  ...over,
});

describe("segments", () => {
  it("puts mentions back at their byte offsets, after multibyte text", () => {
    const mentions = [{ fid: 5, position: Buffer.byteLength("héllo "), name: "bob" }];
    expect(segments("héllo  and !", mentions)).toEqual([
      { text: "héllo " },
      { mention: "@bob", fid: 5 },
      { text: " and !" },
    ]);
  });

  it("names an unknown mention by fid", () => {
    expect(segments("hi ", [{ fid: 5, position: 3, name: null }])).toEqual([
      { text: "hi " },
      { mention: "!5", fid: 5 },
    ]);
  });

  it("links http and https urls, leaving trailing punctuation out", () => {
    expect(segments("see https://example.com/a?b=1. or (http://x.org/y)", [])).toEqual([
      { text: "see " },
      { link: "https://example.com/a?b=1" },
      { text: ". or (" },
      { link: "http://x.org/y" },
      { text: ")" },
    ]);
  });

  it("does not link other schemes", () => {
    expect(segments("javascript:alert(1) data:text/html,x", [])).toEqual([
      { text: "javascript:alert(1) data:text/html,x" },
    ]);
  });

  it("drops control and bidi characters, keeps line breaks, collapses blank runs", () => {
    expect(segments("a‮b\u0007\r\n\n\n\nc  ", [])).toEqual([{ text: "ab\n\nc" }]);
  });
});

describe("toWebCast", () => {
  const none = { likes: new Set<string>(), recasts: new Set<string>() };

  it("adds the age and the cast's farcaster.xyz link, and leaves out what the page never uses", () => {
    const cast = toWebCast(
      item({ channel: "https://example.com/~/channel/casty" }),
      1000 + 7200,
      none,
    );
    expect(cast).toMatchObject({ age: "2h", channel: "https://example.com/~/channel/casty" });
    expect(cast.url).toMatch(/^https:\/\/farcaster\.xyz\/alice\/0xabab/);
    for (const field of ["text", "mentions", "signer", "timestamp"])
      expect(cast).not.toHaveProperty(field);
  });

  it("has no link without an author name", () => {
    expect(toWebCast(item({ author: null }), 1000, none).url).toBeNull();
  });

  it("says whether you liked or recast it", () => {
    const key = `7:0x${"ab".repeat(20)}`;
    const cast = toWebCast(item(), 1000, { likes: new Set([key]), recasts: new Set() });
    expect(cast).toMatchObject({ liked: true, recast: false });
  });

  it("keeps only http and https embeds", () => {
    const embeds = ["https://example.com/x", "javascript:alert(1)", "ftp://x"];
    expect(toWebCast(item({ embeds }), 1000, none).embeds).toEqual(["https://example.com/x"]);
  });
});
