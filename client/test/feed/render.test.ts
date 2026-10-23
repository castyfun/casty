import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type FeedItem,
  formatAge,
  renderFeed,
  toFeedItem,
  withMentions,
} from "../../src/feed/render.js";
import { cast } from "./helpers.js";

const FID = 2_000_000_007;
const APP = 2_000_009_001;

describe("formatAge", () => {
  it.each([
    [5, "5s"],
    [125, "2m"],
    [7200, "2h"],
    [3 * 86400, "3d"],
  ])("%i seconds is %s", (seconds, text) => {
    expect(formatAge(seconds)).toBe(text);
  });
});

describe("renderFeed", () => {
  const item = (over: Partial<FeedItem> = {}): FeedItem => ({
    ...toFeedItem(cast(FID, 1000, "abc")),
    author: "alice",
    app: { fid: APP, name: "app-alpha" },
    ...over,
  });
  const plain = { width: 80, color: false };

  it("numbers each cast and puts author, age and app above its text", () => {
    const items = [item({ text: "hello" }), item({ author: "bob", text: "hi" })];
    expect(renderFeed(items, 1000 + 7200, plain)).toBe(
      "1  @alice · 2h · via app-alpha\n   hello\n\n2  @bob · 2h · via app-alpha\n   hi",
    );
  });

  it("wraps text to the width and keeps the cast's own line breaks", () => {
    const text = "one two three four five six\nseven";
    expect(renderFeed([item({ text })], 1000, { width: 20, color: false })).toBe(
      "1  @alice · 0s · via app-alpha\n   one two three\n   four five six\n   seven",
    );
  });

  it("says what a cast replies to or which channel it is in, and lists its links", () => {
    const reply = item({ parent: { fid: 5, hash: `0x${"ab".repeat(20)}` }, parentAuthor: "carol" });
    const posted = item({
      channel: "https://farcaster.xyz/~/channel/dev",
      embeds: ["https://example.com/a"],
    });
    expect(renderFeed([reply, posted], 1000, plain)).toBe(
      [
        "1  @alice · 0s · via app-alpha · reply to @carol",
        "   cast abc",
        "",
        "2  @alice · 0s · via app-alpha · in /dev",
        "   cast abc",
        "   https://example.com/a",
      ].join("\n"),
    );
  });

  it("says via casty for casts signed with one of this casty's keys", () => {
    expect(renderFeed([item({ ours: true })], 1000, plain)).toMatch(
      /^1 {2}@alice · 0s · via casty\n/,
    );
  });

  it("falls back to fid and app fid when names are unknown", () => {
    const unknown = item({ author: null, app: { fid: APP, name: null } });
    expect(renderFeed([unknown], 1000, plain)).toBe(`1  !${FID} · 0s · via !${APP}\n   cast abc`);
  });

  it("colours the author and the details only when asked to", () => {
    expect(renderFeed([item()], 1000, plain)).not.toContain("\u001b");
    const coloured = renderFeed([item()], 1000, { width: 80, color: true });
    expect(coloured).toContain("\u001b[1m@alice\u001b[0m");
    expect(stripVTControlCharacters(coloured)).toBe(renderFeed([item()], 1000, plain));
  });

  it("says so when the feed is empty", () => {
    expect(renderFeed([], 0, plain)).toBe("no casts");
  });
});

describe("toFeedItem", () => {
  it("normalises a node message", () => {
    const item = toFeedItem(cast(FID, 1000, "abc"));
    expect(item).toMatchObject({
      fid: FID,
      timestamp: 1000,
      text: "cast abc",
      embeds: [],
      mentions: [],
    });
    expect(item.time).toBe("2021-01-01T00:16:40.000Z");
  });
});

describe("untrusted text", () => {
  it("strips terminal control sequences from text, names and links", () => {
    const item = {
      ...toFeedItem(cast(FID, 1000, "abc")),
      text: "hi \u001b]0;owned\u0007there \u001b[2Jend\u202e",
      author: "al\u001b[31mice",
      app: { fid: APP, name: "app\u009b-x" },
      embeds: ["https://example.com/\u001b[8m"],
    };
    expect(renderFeed([item], 1000, { width: 80, color: false })).toBe(
      "1  @al[31mice · 0s · via app-x\n   hi ]0;ownedthere [2Jend\n   https://example.com/[8m",
    );
  });
});

describe("withMentions", () => {
  it("puts mentioned names back at their byte offsets", () => {
    // The second mention follows "gm  and é ": 11 bytes, because "é" takes two, but 10 characters.
    const mentions = [
      { fid: 1, position: 3, name: "alice" },
      { fid: 2, position: 11, name: null },
    ];
    expect(withMentions("gm  and é ", mentions)).toBe("gm @alice and é !2");
  });

  it("leaves text without mentions alone", () => {
    expect(withMentions("plain", [])).toBe("plain");
  });
});
