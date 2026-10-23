import { FIRST_AUTHOR, fixtureKey } from "@casty/mock-node";
import { Message, NobleEd25519Signer } from "@farcaster/core";
import { hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { cachedFixtures } from "../feed/fixtures.js";
import { startMock } from "../mock.js";
import { setupWeb as setup } from "./setup.js";

/** The node paths casty serve asked for while `run` ran, with how many times each. */
async function requestsTo(webUrl: string, run: () => Promise<unknown>) {
  const asked = new Map<string, number>();
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (!url.startsWith(webUrl)) {
      const path = new URL(url).pathname;
      asked.set(path, (asked.get(path) ?? 0) + 1);
    }
    return real(input, init);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

describe("the page over the index", () => {
  it("serves the feed from the index, asking the node for no casts and no reactions", async () => {
    const { api, web } = await setup({ index: true });
    const asked = await requestsTo(web.url, async () => {
      const { status, body } = await api("/api/feed?limit=20&refresh=1");
      expect(status).toBe(200);
      expect(body.items).toHaveLength(20);
    });
    expect(asked.get("/v1/castsByFid") ?? 0).toBe(0);
    expect(asked.get("/v1/linksByFid") ?? 0).toBe(0);
    expect(asked.get("/v1/reactionsByFid") ?? 0).toBe(0);
  });

  it("gives the same feed as the fan-out did", async () => {
    const { api, dir, node } = await setup({ index: true });
    const indexed = (await api("/api/feed?limit=30")).body.items;
    const { api: plain } = await setup({ node, dir });
    const fanned = (await plain("/api/feed?limit=30")).body.items;
    expect(indexed.map((c: { hash: string }) => c.hash)).toEqual(
      fanned.map((c: { hash: string }) => c.hash),
    );
  });

  it("shows a write at once: the cast you just made, the like you just gave", async () => {
    const { api } = await setup({ index: true });
    const { body } = await api("/api/cast", { text: "straight into the index" });
    const [top] = (await api("/api/feed?limit=1")).body.items;
    expect(top).toMatchObject({ hash: body.hash, ours: true, liked: false });
    await api("/api/react", {
      reaction: "Like",
      undo: false,
      target: { fid: top.fid, hash: top.hash },
    });
    expect((await api("/api/feed?limit=1")).body.items[0].liked).toBe(true);
  });

  it("lists mentions from the index, and a reply made elsewhere once the events bring it", async () => {
    const { api, node, web } = await setup({ index: true });
    const mine = (await api("/api/cast", { text: "anyone?" })).body;
    // The first count starts from now: what was already there is not new.
    expect((await api("/api/unseen?limit=10")).body).toEqual({ mentions: 0 });
    const reply = await buildCast(
      FIRST_AUTHOR,
      { text: "from the index", parent: { fid: mine.fid, hash: hexToBytes(mine.hash) } },
      new NobleEd25519Signer(fixtureKey(42, FIRST_AUTHOR)),
    );
    await nodeClient(node.url).submitMessage(Message.encode(reply).finish());
    const asked = await requestsTo(web.url, async () => {
      // The events are read every 50 ms here; a refresh forgets what was answered before.
      // Counted before the list is shown, which marks it seen.
      await vi.waitFor(async () =>
        expect((await api("/api/unseen?limit=10&refresh=1")).body.mentions).toBeGreaterThan(0),
      );
      const texts = (await api("/api/mentions?limit=10&refresh=1")).body.items.map(
        (c: { segments: { text?: string }[] }) => c.segments.map((s) => s.text).join(""),
      );
      expect(texts).toContain("from the index");
    });
    expect(asked.get("/v1/castsByMention") ?? 0).toBe(0);
    expect(asked.get("/v1/castsByParent") ?? 0).toBe(0);
  });

  it("falls back to the fan-out until the first pass is done", async () => {
    const { api, web } = await setup({ index: "cold" });
    const asked = await requestsTo(web.url, async () => {
      expect((await api("/api/feed?limit=5")).body.items).toHaveLength(5);
    });
    expect(asked.get("/v1/castsByFid") ?? 0).toBeGreaterThan(0);
  });

  it("names the index in the session, so the page can say where the feed comes from", async () => {
    const { api } = await setup({ index: true });
    expect((await api("/api/session")).body.index).toBe(true);
    const { api: plain } = await setup();
    expect((await plain("/api/session")).body.index).toBe(false);
  });
});

describe("the feed of 300 follows over the index", () => {
  it.skipIf(!process.env.CASTY_TIMING)(
    "is answered in under 20 ms once the names are known",
    { timeout: 60_000 },
    async () => {
      const node = await startMock({
        fixtures: await cachedFixtures({ fids: 300, casts: 50, seed: 42 }),
      });
      const { api } = await setup({ index: true, node });
      await api("/api/feed?limit=50");
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const { body } = await api("/api/feed?limit=50&refresh=1&number=1");
        times.push(performance.now() - started);
        expect(body.items).toHaveLength(50);
      }
      expect(Math.min(...times)).toBeLessThan(20);
    },
  );
});

describe("a write while the index is cold", () => {
  it("is answered without waiting for the first pass", async () => {
    const { api } = await setup({ index: "cold" });
    const started = performance.now();
    const { status } = await api("/api/cast", { text: "while the index is still reading" });
    expect(status).toBe(200);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("after the first pass", () => {
  it("knows the names and apps of your follows, so the first feed asks the node for nothing", async () => {
    const { api, web } = await setup({ index: true });
    // The names and apps are read right after the first pass; a dozen accounts take a moment.
    await new Promise((r) => setTimeout(r, 400));
    const asked = await requestsTo(web.url, () => api("/api/feed?limit=20&refresh=1"));
    expect(asked.get("/v1/userDataByFid") ?? 0).toBe(0);
    expect(asked.get("/v1/signersByFid") ?? 0).toBe(0);
  });
});
