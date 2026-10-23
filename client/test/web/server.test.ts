import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { FIRST_AUTHOR, fixtureKey, ME_FID } from "@casty/mock-node";
import { Message, NobleEd25519Signer } from "@farcaster/core";
import { hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { chooseToken, saveToken } from "../../src/web/server.js";
import { tempConfig } from "../cli/harness.js";
import { setupWeb as setup, TOKEN } from "./setup.js";

/** A cast's text as the page shows it, from its segments. */
const textOf = (cast: { segments: Record<string, string>[] }) =>
  cast.segments.map((s) => s.text ?? s.mention ?? s.link).join("");

/** Gives `fid` a user data value on the mock, as if it had set it from an app. */
function setUserData(
  node: Awaited<ReturnType<typeof setup>>["node"],
  fid: number,
  type: string,
  value: string,
) {
  const [username] = node.state.userdata.filter((m) => m.data.fid === fid);
  if (!username) throw new Error(`fixture fid ${fid} has no user data`);
  const message = structuredClone(username);
  message.data.userDataBody = { type, value };
  message.hash = `0x${type.length.toString(16).padStart(2, "0")}${"ab".repeat(19)}`;
  node.state.userdata.push(message);
}

/** How many requests casty web sent to the node while `run` ran. */
async function nodeRequests(webUrl: string, run: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (!String(input).startsWith(webUrl)) count++;
    return real(input, init);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return count;
}

/** The node paths casty web asked for while `run` ran, with how many times each. */
async function requestsTo(
  webUrl: string,
  run: () => Promise<unknown>,
): Promise<Map<string, number>> {
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

/** Status and headers of a GET, without decompressing anything. */
function head(url: string, headers: Record<string, string>, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    request(url, { headers, method }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    })
      .on("error", reject)
      .end();
  });
}

/** A raw request, for headers fetch will not let a caller set. */
function raw(url: string, headers: Record<string, string>, setHost = true): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, { headers, setHost }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("the page", () => {
  it("is served with a policy that allows only its own scripts and styles", async () => {
    const { web } = await setup();
    const res = await fetch(web.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sends its files gzipped with an ETag, and nothing again while they are unchanged", async () => {
    const { web } = await setup();
    const first = await head(`${web.url}/app.js`, { "accept-encoding": "gzip" });
    expect(first.status).toBe(200);
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.headers.vary).toBe("accept-encoding");
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[\w-]+"$/);
    const again = await head(`${web.url}/app.js`, {
      "accept-encoding": "gzip",
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    expect(again.headers.vary).toBe("accept-encoding");
    const plain = await head(`${web.url}/app.js`, {});
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.etag).not.toBe(etag);
    expect(Number(plain.headers["content-length"])).toBeGreaterThan(1024);
    const refused = await head(`${web.url}/app.js`, { "accept-encoding": "gzip;q=0, br" });
    expect(refused.headers["content-encoding"]).toBeUndefined();
  });

  it("answers HEAD for its files", async () => {
    const { web } = await setup();
    const res = await head(`${web.url}/app.css`, {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/css/);
  });

  it("gzips a large API answer when the browser takes gzip", async () => {
    const { web } = await setup();
    const res = await head(`${web.url}/api/feed?limit=20`, {
      "accept-encoding": "gzip, deflate",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("can load every file it references", async () => {
    const { web } = await setup();
    const html = await (await fetch(web.url)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(2);
    for (const ref of refs) expect((await fetch(`${web.url}${ref}`)).status, ref).toBe(200);
  });

  it("answers 404 for anything else", async () => {
    const { web, api } = await setup();
    expect((await fetch(`${web.url}/../keys.enc.json`)).status).toBe(404);
    expect((await fetch(`${web.url}/web-token`)).status).toBe(404);
    expect((await api("/api/nope")).status).toBe(404);
  });

  it("refuses a Host that is not an IP address or localhost, against DNS rebinding", async () => {
    const { web } = await setup();
    const port = new URL(web.url).port;
    expect(await raw(web.url, { host: "evil.example" })).toBe(403);
    expect(await raw(web.url, { host: `localhost.:${port}` })).toBe(403);
    expect(await raw(web.url, {}, false)).toBe(400); // node:http itself refuses a missing Host
    expect(await raw(web.url, { host: `localhost:${port}` })).toBe(200);
    expect(await raw(web.url, { host: `[::1]:${port}` })).toBe(200);
  });
});

describe("the API", () => {
  it("needs the token", async () => {
    const { api } = await setup();
    expect((await api("/api/session", undefined, "wrong")).status).toBe(401);
    const res = await fetch(`${(await setup()).web.url}/api/session`);
    expect(res.status).toBe(401);
  });

  it("takes writes only as JSON, so a cross-site form cannot post", async () => {
    const { web } = await setup();
    const res = await fetch(`${web.url}/api/cast`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(415);
  });

  it("describes the session: fid, username, the cast limits and the node's sync", async () => {
    const { api } = await setup();
    const { status, body } = await api("/api/session");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      fid: ME_FID,
      username: "casty-test",
      canWrite: true,
      limits: { cast: 320, longCast: 1024, feed: 200 },
      node: { synced: true, behind: expect.stringMatching(/^\d+s$/) },
    });
  });

  it("serves the feed with text segments, ages and links", async () => {
    const { api } = await setup();
    const { status, body } = await api("/api/feed?limit=5");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(5);
    expect(body.items[0]).toMatchObject({ liked: false, recast: false });
    expect(body.items[0].segments.length).toBeGreaterThan(0);
    expect(body.items[0].age).toMatch(/^\d+[smhd]$/);
  });

  it("lists what others said to you, numbered for the terminal on request", async () => {
    const { api, dir } = await setup();
    const { status, body } = await api("/api/mentions?limit=5&number=1");
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((c: { fid: number }) => c.fid !== ME_FID)).toBe(true);
    expect(body.items[0].segments.length).toBeGreaterThan(0);
    const [remembered] = JSON.parse(readFileSync(join(dir, "last-feed.json"), "utf8"));
    expect(remembered).toEqual({ fid: body.items[0].fid, hash: body.items[0].hash });
  });

  it("counts the mentions that came after the list was last shown", async () => {
    const { api, node } = await setup();
    const mine = (await api("/api/cast", { text: "anyone?" })).body;
    // The first count starts from now: what was already there is not new.
    expect((await api("/api/unseen?limit=30")).body).toEqual({ mentions: 0 });
    const reply = await buildCast(
      FIRST_AUTHOR,
      { text: "here", parent: { fid: mine.fid, hash: hexToBytes(mine.hash) } },
      new NobleEd25519Signer(fixtureKey(42, FIRST_AUTHOR)),
    );
    await nodeClient(node.url).submitMessage(Message.encode(reply).finish());
    expect((await api("/api/unseen?limit=30&refresh=1")).body).toEqual({ mentions: 1 });
    await api("/api/mentions?limit=30");
    expect((await api("/api/unseen?limit=30")).body).toEqual({ mentions: 0 });
  });

  it("answers every open page's count of new mentions from one read for a minute and a half", async () => {
    const { api, web } = await setup();
    await api("/api/unseen?limit=30");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      expect(await nodeRequests(web.url, () => api("/api/unseen?limit=30"))).toBe(0);
      vi.setSystemTime(Date.now() + 31_000);
      expect(await nodeRequests(web.url, () => api("/api/unseen?limit=30"))).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a known @name as a mention, and names the ones it sent as text", async () => {
    const { api, node } = await setup();
    const { status, body } = await api("/api/cast", {
      text: `hi @user-${FIRST_AUTHOR} @nobody-here`,
    });
    expect(status).toBe(200);
    expect(body.plain).toEqual(["nobody-here"]);
    const sent = node.state.casts.find((c) => c.hash === body.hash)?.data.castAddBody;
    expect(sent).toMatchObject({ text: "hi  @nobody-here", mentions: [FIRST_AUTHOR] });
  });

  it("reads casts afresh on reload=1 but keeps the follow list, which refresh=1 reads too", async () => {
    const { api, web } = await setup();
    await api("/api/feed?limit=5");
    const reload = await requestsTo(web.url, () => api("/api/feed?limit=5&reload=1"));
    expect(reload.get("/v1/castsByFid") ?? 0).toBeGreaterThan(0);
    expect(reload.get("/v1/linksByFid") ?? 0).toBe(0);
    const refresh = await requestsTo(web.url, () => api("/api/feed?limit=5&refresh=1"));
    expect(refresh.get("/v1/linksByFid") ?? 0).toBeGreaterThan(0);
  });

  it("keeps app labels and usernames in memory from one request to the next", async () => {
    const { api, web, dir } = await setup();
    await api("/api/feed?limit=5");
    rmSync(join(dir, "cache"), { recursive: true, force: true });
    const asked = await requestsTo(web.url, () => api("/api/feed?limit=5&refresh=1"));
    expect(asked.get("/v1/signersByFid") ?? 0).toBe(0);
    expect(asked.get("/v1/userDataByFid") ?? 0).toBe(0);
  });

  it("shows a like older than your newest 100 reactions as liked", async () => {
    const { api, node, web } = await setup();
    const [old] = (await api("/api/feed?limit=30")).body.items.slice(-1);
    expect((await api("/api/react", { reaction: "Like", undo: false, target: old })).status).toBe(
      200,
    );
    const like = node.state.reactions.at(-1);
    if (!like) throw new Error("the like is not on the mock");
    // 100 likes made after it, of casts that are not on the page.
    for (let i = 1; i <= 100; i++) {
      const later = structuredClone(like);
      later.data.timestamp += i;
      later.hash = `0x${i.toString(16).padStart(40, "0")}`;
      if (later.data.reactionBody?.targetCastId) {
        later.data.reactionBody.targetCastId.hash = `0x${(i + 1000).toString(16).padStart(40, "0")}`;
      }
      node.state.reactions.push(later);
    }
    const asked = await requestsTo(web.url, async () => {
      const items = (await api("/api/feed?limit=30&refresh=1")).body.items;
      expect(items.find((c: { hash: string }) => c.hash === old.hash)?.liked).toBe(true);
    });
    // One more page of reactions reaches it; no cast is asked about one by one.
    expect(asked.get("/v1/reactionById") ?? 0).toBe(0);
  });

  it("asks about a cast one by one when even 1000 of your reactions do not reach it", async () => {
    const { api, node, web } = await setup();
    const [old] = (await api("/api/feed?limit=30")).body.items.slice(-1);
    await api("/api/react", { reaction: "Like", undo: false, target: old });
    const like = node.state.reactions.at(-1);
    if (!like) throw new Error("the like is not on the mock");
    for (let i = 1; i <= 1000; i++) {
      const later = structuredClone(like);
      later.data.timestamp += i;
      later.hash = `0x${i.toString(16).padStart(40, "0")}`;
      if (later.data.reactionBody?.targetCastId) {
        later.data.reactionBody.targetCastId.hash = `0x${(i + 5000).toString(16).padStart(40, "0")}`;
      }
      node.state.reactions.push(later);
    }
    const asked = await requestsTo(web.url, async () => {
      const items = (await api("/api/feed?limit=30&refresh=1")).body.items;
      expect(items.find((c: { hash: string }) => c.hash === old.hash)?.liked).toBe(true);
    });
    expect(asked.get("/v1/reactionsByFid") ?? 0).toBeLessThanOrEqual(20);
    expect(asked.get("/v1/reactionById") ?? 0).toBeGreaterThan(0);
  });

  it("gives a numbered list its turn only when it saved the numbers last", async () => {
    const { api, node } = await setup();
    node.control({ latencyMs: 50 });
    const feed = api("/api/feed?limit=5&number=1&refresh=1");
    await vi.waitFor(() => expect(node.state.stats.inFlight).toBeGreaterThan(0));
    const mentions = await api("/api/mentions?limit=5&number=1");
    expect(mentions.body.turn).toBeGreaterThan(0);
    expect((await feed).body.turn).toBe(0);
  });

  it("answers a repeated read from memory, so a filter toggled shows at once", async () => {
    const { api, web } = await setup();
    await api("/api/feed?limit=20");
    const asked = await nodeRequests(web.url, () => api("/api/feed?limit=20&replies=0"));
    expect(asked).toBe(0);
  });

  it("shows a reply made elsewhere once mentions are refreshed", async () => {
    const { api, node } = await setup();
    const mine = (await api("/api/cast", { text: "anyone?" })).body;
    await api("/api/mentions?limit=50");
    const reply = await buildCast(
      FIRST_AUTHOR,
      { text: "here", parent: { fid: mine.fid, hash: hexToBytes(mine.hash) } },
      new NobleEd25519Signer(fixtureKey(42, FIRST_AUTHOR)),
    );
    await nodeClient(node.url).submitMessage(Message.encode(reply).finish());
    const texts = async (path: string) => (await api(path)).body.items.map(textOf);
    expect(await texts("/api/mentions?limit=50")).not.toContain("here");
    expect(await texts("/api/mentions?limit=50&refresh=1")).toContain("here");
  });

  it("asks the node for its status every time, so the clock and the sync dot are current", async () => {
    const { api, web } = await setup();
    await api("/api/session");
    expect(await nodeRequests(web.url, () => api("/api/session"))).toBeGreaterThan(0);
  });

  it("reads afresh after a write and on refresh", async () => {
    const { api, web } = await setup();
    await api("/api/feed?limit=5");
    await api("/api/cast", { text: "new" });
    expect(textOf((await api("/api/feed?limit=5")).body.items[0])).toBe("new");
    expect(await nodeRequests(web.url, () => api("/api/feed?limit=5&refresh=1"))).toBeGreaterThan(
      0,
    );
  });

  it("filters the feed by app and replies", async () => {
    const { api } = await setup();
    const all = (await api("/api/feed?limit=20")).body.items;
    const apps = new Set(all.map((c: { app: { name: string } }) => c.app?.name));
    expect(apps.size).toBeGreaterThan(1);
    const hidden = [...apps][0] as string;
    const some = (await api(`/api/feed?limit=20&exclude=${hidden}`)).body.items;
    expect(some.every((c: { app: { name: string } }) => c.app?.name !== hidden)).toBe(true);
    const noReplies = (await api("/api/feed?limit=20&replies=0")).body.items;
    expect(noReplies.every((c: { parent: unknown }) => c.parent === null)).toBe(true);
  });

  it("casts, and the cast is on the node and at the top of the feed", async () => {
    const { api, node } = await setup();
    const { status, body } = await api("/api/cast", { text: "hello from the browser" });
    expect(status).toBe(200);
    expect(body.hash).toMatch(/^0x[0-9a-f]{40}$/);
    expect(body.url).toMatch(/^https:\/\/farcaster\.xyz\/casty-test\//);
    expect(node.state.casts.some((c) => c.hash === body.hash)).toBe(true);
    const [top] = (await api("/api/feed?limit=1")).body.items;
    expect(top).toMatchObject({ hash: body.hash, ours: true });
  });

  it("replies to a cast", async () => {
    const { api, node } = await setup();
    const [target] = (await api("/api/feed?limit=5")).body.items.filter(
      (c: { fid: number }) => c.fid !== ME_FID,
    );
    const parent = { fid: target.fid, hash: target.hash };
    const { body } = await api("/api/cast", { text: "agreed", parent });
    const reply = node.state.casts.find((c) => c.hash === body.hash);
    expect(reply?.data.castAddBody?.parentCastId).toEqual(parent);
  });

  it("refuses a cast over 1024 bytes with the reason", async () => {
    const { api } = await setup();
    const { status, body } = await api("/api/cast", { text: "x".repeat(1025) });
    expect(status).toBe(400);
    expect(body.error).toContain("1025 bytes");
  });

  it("refuses a body over 16 KB", async () => {
    const { api } = await setup();
    expect((await api("/api/cast", { text: "x".repeat(17 * 1024) })).status).toBe(413);
  });

  it("refuses a target whose fid is not a positive whole number", async () => {
    const { api } = await setup();
    const hash = `0x${"ab".repeat(20)}`;
    for (const fid of [-1, 0, 1e30, 1.5]) {
      const { status } = await api("/api/react", { reaction: "Like", target: { fid, hash } });
      expect(status, String(fid)).toBe(400);
    }
  });

  it("takes parent: null as a cast that replies to nothing", async () => {
    const { api } = await setup();
    expect((await api("/api/cast", { text: "top level", parent: null })).status).toBe(200);
  });

  it("refuses a malformed body with what is wrong", async () => {
    const { api } = await setup();
    const { status, body } = await api("/api/react", { reaction: "Like", target: { fid: 1 } });
    expect(status).toBe(400);
    expect(body.error).toContain("target");
  });

  it("likes and unlikes, and the feed shows it", async () => {
    const { api } = await setup();
    const [first] = (await api("/api/feed?limit=1")).body.items;
    const target = { fid: first.fid, hash: first.hash };
    expect((await api("/api/react", { reaction: "Like", undo: false, target })).status).toBe(200);
    expect((await api("/api/feed?limit=1")).body.items[0].liked).toBe(true);
    expect((await api("/api/react", { reaction: "Like", undo: true, target })).status).toBe(200);
    expect((await api("/api/feed?limit=1")).body.items[0].liked).toBe(false);
  });

  it("recasts", async () => {
    const { api } = await setup();
    const [first] = (await api("/api/feed?limit=1")).body.items;
    const target = { fid: first.fid, hash: first.hash };
    await api("/api/react", { reaction: "Recast", undo: false, target });
    expect((await api("/api/feed?limit=1")).body.items[0].recast).toBe(true);
  });

  it("deletes your own cast and refuses someone else's", async () => {
    const { api, node } = await setup();
    const mine = await api("/api/cast", { text: "short-lived" });
    expect((await api("/api/delete", { target: mine.body })).status).toBe(200);
    expect(node.state.casts.some((c) => c.hash === mine.body.hash)).toBe(false);
    const other = node.state.casts.find((c) => c.data.fid === FIRST_AUTHOR);
    const refused = await api("/api/delete", { target: { fid: FIRST_AUTHOR, hash: other?.hash } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("not yours");
  });

  it("shows a cast with what it replies to and its replies", async () => {
    const { api } = await setup();
    const items = (await api("/api/feed?limit=50")).body.items;
    const reply = items.find((c: { parent: unknown }) => c.parent !== null);
    const { status, body } = await api(`/api/thread?fid=${reply.fid}&hash=${reply.hash}`);
    expect(status).toBe(200);
    expect(body.cast.hash).toBe(reply.hash);
    expect(body.parent).toMatchObject(reply.parent);
    const parent = await api(`/api/thread?fid=${reply.parent.fid}&hash=${reply.parent.hash}`);
    expect(parent.body.replies.map((c: { hash: string }) => c.hash)).toContain(reply.hash);
  });

  it("answers 404 for a thread of a cast the node does not have", async () => {
    const { api } = await setup();
    const { status } = await api(`/api/thread?fid=${ME_FID}&hash=0x${"0".repeat(40)}`);
    expect(status).toBe(404);
  });

  it("describes you: custody, app keys, storage and the node", async () => {
    const { api, dir } = await setup();
    const { status, body } = await api("/api/me");
    expect(status).toBe(200);
    expect(body).toMatchObject({ fid: ME_FID, username: "casty-test" });
    expect(body.custody).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.keys.some((k: { ours: boolean }) => k.ours)).toBe(true);
    expect(body.storage.units).toBeGreaterThan(0);
    expect(body.storage.stores[0]).toMatchObject({
      store: expect.any(String),
      used: expect.any(Number),
    });
    expect(body.node).toMatchObject({ synced: true, version: expect.any(String) });
    expect(body.node.shards.length).toBeGreaterThan(0);
    expect(body.configDir).toBe(dir);
  });

  it("shows a profile: name, whether you follow it, its apps and its casts", async () => {
    const { api } = await setup();
    const { status, body } = await api(`/api/profile?fid=${FIRST_AUTHOR}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      fid: FIRST_AUTHOR,
      username: expect.any(String),
      following: true,
    });
    expect(body.apps.length).toBeGreaterThan(0);
    expect(body.apps[0]).toMatchObject({ fid: expect.any(Number), keys: expect.any(Number) });
    expect(body.casts.length).toBeGreaterThan(0);
    expect(body.casts.every((c: { fid: number }) => c.fid === FIRST_AUTHOR)).toBe(true);
  });

  it("shows a profile's display name and bio, cleaned of control characters", async () => {
    const { api, node } = await setup();
    setUserData(node, FIRST_AUTHOR, "USER_DATA_TYPE_DISPLAY", "First\u202e Author");
    setUserData(node, FIRST_AUTHOR, "USER_DATA_TYPE_BIO", "builds things.\nlikes trains.");
    const { body } = await api(`/api/profile?fid=${FIRST_AUTHOR}`);
    expect(body).toMatchObject({ display: "First Author", bio: "builds things.\nlikes trains." });
    expect(body.username).toMatch(/^user-/);
    const bare = (await api(`/api/profile?fid=${FIRST_AUTHOR + 1}`)).body;
    expect(bare).toMatchObject({ display: null, bio: null });
  });

  it("unfollows and follows again", async () => {
    const { api } = await setup();
    expect((await api("/api/follow", { fid: FIRST_AUTHOR, undo: true })).status).toBe(200);
    expect((await api(`/api/profile?fid=${FIRST_AUTHOR}`)).body.following).toBe(false);
    expect((await api("/api/follow", { fid: FIRST_AUTHOR, undo: false })).status).toBe(200);
    expect((await api(`/api/profile?fid=${FIRST_AUTHOR}`)).body.following).toBe(true);
  });

  it("finds a fid by username through the node", async () => {
    const { api } = await setup();
    const author = (await api(`/api/profile?fid=${FIRST_AUTHOR}`)).body.username;
    expect((await api(`/api/resolve?name=@${author}`)).body).toEqual({ fid: FIRST_AUTHOR });
    const missing = await api("/api/resolve?name=nobody-here");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("no fid found");
  });

  it("asks the fname registry for a name the node does not know", async () => {
    const asked: string[] = [];
    const registry = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.end(JSON.stringify({ transfers: [{ to: FIRST_AUTHOR }] }));
    });
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const { port } = registry.address() as { port: number };
    try {
      const { api } = await setup({ fnameServer: `http://127.0.0.1:${port}` });
      const { body } = await api("/api/resolve?name=@elsewhere");
      expect(body).toEqual({ fid: FIRST_AUTHOR });
      expect(asked).toEqual(["/transfers?name=elsewhere"]);
    } finally {
      registry.close();
    }
  });

  it("casts in a channel with links", async () => {
    const { api, node } = await setup();
    const embeds = ["https://example.com/one", "https://example.com/two"];
    const channel = "https://example.com/~/channel/casty";
    const { body } = await api("/api/cast", { text: "with links", embeds, channel });
    const cast = node.state.casts.find((c) => c.hash === body.hash)?.data.castAddBody;
    expect(cast?.embeds.map((e) => e.url)).toEqual(embeds);
    expect(cast?.parentUrl).toBe(channel);
  });

  it("casts in a channel named /name once a numbered list has shown it", async () => {
    const { api, node } = await setup();
    const early = await api("/api/cast", { text: "x", channel: "/casty" });
    expect(early.status).toBe(400);
    expect(early.body.error).toContain("no channel /casty shown yet");
    await api("/api/feed?number=1");
    const { body } = await api("/api/cast", { text: "by name", channel: "/casty" });
    const cast = node.state.casts.find((c) => c.hash === body.hash)?.data.castAddBody;
    expect(cast?.parentUrl).toBe("https://example.com/~/channel/casty");
  });

  it("refuses more than two links, or a link that is not http(s)", async () => {
    const { api } = await setup();
    const three = ["https://a.example", "https://b.example", "https://c.example"];
    expect((await api("/api/cast", { text: "x", embeds: three })).status).toBe(400);
    expect((await api("/api/cast", { text: "x", embeds: ["javascript:alert(1)"] })).status).toBe(
      400,
    );
  });

  it("numbers the feed for the terminal when the page asks: casty like 1 is the first shown", async () => {
    const { api, dir } = await setup();
    await api("/api/feed?limit=3");
    expect(existsSync(join(dir, "last-feed.json"))).toBe(false);
    const [first] = (await api("/api/feed?limit=3&number=1")).body.items;
    const [remembered] = JSON.parse(readFileSync(join(dir, "last-feed.json"), "utf8"));
    expect(remembered).toEqual({ fid: first.fid, hash: first.hash });
  });

  it("shows a follow or an unfollow in the feed at once", async () => {
    const { api } = await setup();
    const theirs = async () =>
      (await api("/api/feed?limit=100")).body.items.filter(
        (c: { fid: number }) => c.fid === FIRST_AUTHOR,
      ).length;
    expect(await theirs()).toBeGreaterThan(0);
    await api("/api/follow", { fid: FIRST_AUTHOR, undo: true });
    expect(await theirs()).toBe(0);
    await api("/api/follow", { fid: FIRST_AUTHOR, undo: false });
    expect(await theirs()).toBeGreaterThan(0);
  });

  it("answers 403 when the local setup cannot write, with the hint", async () => {
    const sign = () => {
      throw new ConfigError("none of the app keys is registered", "run casty init");
    };
    const { api } = await setup({ sign });
    const { status, body } = await api("/api/cast", { text: "hi" });
    expect(status).toBe(403);
    expect(body.hint).toBe("run casty init");
  });

  it("counts only writes as pending, so Ctrl-C does not wait for a read", async () => {
    const { api, node, web } = await setup();
    node.control({ latencyMs: 150 });
    const read = api("/api/feed?limit=1");
    await vi.waitFor(() => expect(node.state.stats.inFlight).toBeGreaterThan(0));
    expect(web.pending()).toBe(0);
    await read;
  });

  it("finishes a write in flight before it closes", async () => {
    const { api, node, web } = await setup();
    node.control({ mergeDelayMs: 300 });
    const write = api("/api/cast", { text: "slow to merge" });
    await vi.waitFor(() => expect(web.pending()).toBe(1));
    await web.close();
    expect((await write).status).toBe(200);
  });

  it("is read-only without an unlocked key", async () => {
    const { api } = await setup({ write: false });
    expect((await api("/api/session")).body.canWrite).toBe(false);
    const { status, body } = await api("/api/cast", { text: "hi" });
    expect(status).toBe(403);
    expect(body.hint).toContain("casty web");
  });

  it("refuses a cast on a read-only page before looking up the names in it", async () => {
    const { api, web } = await setup({ write: false });
    const asked = await requestsTo(web.url, async () => {
      expect((await api("/api/cast", { text: "hi @nobody-here" })).status).toBe(403);
    });
    expect(asked.get("/v1/userNameProofByName") ?? 0).toBe(0);
  });

  it("passes on the node's errors with their hints", async () => {
    const { api, node } = await setup();
    await node.close();
    const { status, body } = await api("/api/feed");
    expect(status).toBe(502);
    expect(body.error).toContain("cannot reach the node");
    expect(body.hint).toContain("tunnel");
  });
});

describe("the token", () => {
  it("is kept readable only by you and reused until renewed", () => {
    const dir = tempConfig();
    const token = chooseToken(dir, false);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    saveToken(dir, token);
    expect(statSync(join(dir, "web-token")).mode & 0o777).toBe(0o600);
    expect(chooseToken(dir, false)).toBe(token);
    expect(chooseToken(dir, true)).not.toBe(token);
    expect(chooseToken(dir, false)).toBe(token);
  });
});

describe("the session's app key", () => {
  it("names when the soonest of this casty's keys lapses, so the page can warn", async () => {
    const { api, node } = await setup();
    expect((await api("/api/session")).body.keyExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const mine = node.state.signers.get(ME_FID)?.signers.find((s) => s.ttl);
    if (!mine) throw new Error("init added no key");
    mine.expiresAt = Math.floor(Date.now() / 1000) + 2 * 86_400;
    const { body } = await api("/api/session?refresh=1");
    expect(new Date(body.keyExpiresAt).getTime()).toBeCloseTo(mine.expiresAt * 1000, -4);
  });
});

describe("verified addresses", () => {
  it("are listed on a profile by protocol, as the node holds them", async () => {
    const { api } = await setup();
    const { body } = await api(`/api/profile?fid=${FIRST_AUTHOR}`);
    expect(body.verifications).toEqual([
      { protocol: "ethereum", address: expect.stringMatching(/^0x[0-9a-f]{40}$/) },
    ]);
    expect((await api(`/api/profile?fid=${FIRST_AUTHOR + 1}`)).body.verifications).toEqual([]);
  });
});

describe("your own verified addresses", () => {
  it("come with your account under /api/me", async () => {
    const { api } = await setup();
    expect((await api("/api/me")).body.verifications).toEqual([]);
  });
});
