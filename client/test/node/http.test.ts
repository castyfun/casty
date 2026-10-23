import { createServer } from "node:http";
import {
  APPS,
  CHANNEL_URL,
  FIRST_AUTHOR,
  FIXTURE_TIME,
  fixtureKey,
  ME_FID,
  NO_STORAGE_FID,
  TEST_MNEMONIC,
} from "@casty/mock-node";
import { Message, NobleEd25519Signer, ReactionType } from "@farcaster/core";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { NodeError, NodeUnreachableError } from "../../src/node/errors.js";
import { allPages, type NodeMessage, nodeClient } from "../../src/node/http.js";
import { buildCast, buildCastRemove, buildReaction } from "../../src/protocol/messages.js";
import { cast } from "../feed/helpers.js";
import { startMock } from "../mock.js";

const AUTHOR = FIRST_AUTHOR;
const authorSigner = () => new NobleEd25519Signer(fixtureKey(42, AUTHOR));

async function client() {
  const node = await startMock();
  return { node, api: nodeClient(node.url) };
}

describe("reads", () => {
  it("info: shards, version and the node's clock", async () => {
    const { api } = await client();
    const { info, date } = await api.info();
    expect(info.shardInfos.map((s) => s.shardId)).toEqual([0, 1, 2]);
    expect(info.version).toBeTruthy();
    expect(date).toBeInstanceOf(Date);
  });

  it("castsByFid: pages until the token is empty, reverse gives newest first", async () => {
    const { api } = await client();
    const first = await api.castsByFid(AUTHOR, { pageSize: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextPageToken).not.toBe("");
    const last = await api.castsByFid(AUTHOR, { pageSize: 3, pageToken: first.nextPageToken });
    expect(last.items).toHaveLength(1);
    expect(last.nextPageToken).toBe("");

    const newest = await api.castsByFid(AUTHOR, { reverse: true });
    const times = newest.items.map((m) => m.data.timestamp);
    expect(times).toEqual(times.toSorted((a, b) => b - a));
  });

  it("allPages walks every page", async () => {
    const { api } = await client();
    const all = [];
    for await (const cast of allPages((pageToken) =>
      api.castsByFid(AUTHOR, { pageSize: 1, pageToken }),
    )) {
      all.push(cast);
    }
    expect(all).toHaveLength(4);
  });

  it("castById: a cast by hash, undefined when unknown", async () => {
    const { api } = await client();
    const [cast] = (await api.castsByFid(AUTHOR)).items;
    if (!cast) throw new Error("fixture has no casts");
    expect((await api.castById(AUTHOR, cast.hash))?.hash).toBe(cast.hash);
    expect(await api.castById(AUTHOR, `0x${"00".repeat(20)}`)).toBeUndefined();
  });

  it("castsByParent: replies to a cast, and posts in a channel url", async () => {
    const { api } = await client();
    const reply = (await api.castsByFid(AUTHOR)).items.find(
      (c) => c.data.castAddBody?.parentCastId,
    );
    const parent = reply?.data.castAddBody?.parentCastId;
    if (!parent) throw new Error("fixture has no reply");
    expect((await api.castsByParent(parent)).items.map((c) => c.hash)).toContain(reply.hash);
    const channel = await api.castsByParent({ url: CHANNEL_URL });
    expect(channel.items.length).toBeGreaterThan(0);
    expect(channel.items.every((c) => c.data.castAddBody?.parentUrl === CHANNEL_URL)).toBe(true);
  });

  it("castsByMention: casts that mention fid 1", async () => {
    const { api } = await client();
    const mentions = await api.castsByMention(ME_FID);
    expect(mentions.items.length).toBeGreaterThan(0);
    expect(mentions.items.every((c) => c.data.castAddBody?.mentions.includes(ME_FID))).toBe(true);
  });

  it("reactionsByFid and reactionById agree; a reaction that is not there is undefined", async () => {
    const { api } = await client();
    const [reaction] = (await api.reactionsByFid(AUTHOR, "Like")).items;
    const target = reaction?.data.reactionBody?.targetCastId;
    if (!target) throw new Error("fixture has no like");
    expect((await api.reactionById(AUTHOR, "Like", target))?.hash).toBe(reaction.hash);
    expect(await api.reactionById(AUTHOR, "Recast", target)).toBeUndefined();
    expect((await api.reactionsByFid(AUTHOR, "Recast")).items).toEqual([]);
  });

  it("linkById finds a follow by its two fids; one that is not there is undefined", async () => {
    const { api } = await client();
    expect((await api.linkById(ME_FID, AUTHOR))?.data.linkBody?.targetFid).toBe(AUTHOR);
    expect(await api.linkById(AUTHOR, NO_STORAGE_FID)).toBeUndefined();
  });

  it("linksByFid: fid 1 follows the authors", async () => {
    const { api } = await client();
    const follows = await api.linksByFid(ME_FID);
    expect(follows.items.map((l) => l.data.linkBody?.targetFid)).toContain(AUTHOR);
  });

  it("userDataByFid: one type, or all of them", async () => {
    const { api } = await client();
    const [username] = await api.userDataByFid(ME_FID, "USER_DATA_TYPE_USERNAME");
    expect(username?.data.userDataBody?.value).toBe("casty-test");
    expect(await api.userDataByFid(ME_FID, "USER_DATA_TYPE_BIO")).toEqual([]);
    expect((await api.userDataByFid(ME_FID)).length).toBeGreaterThan(0);
  });

  it("signersByFid: keys, nonces and requested app nonces", async () => {
    const { api } = await client();
    const signers = await api.signersByFid(AUTHOR, [APPS[0].fid]);
    expect(signers.signers[0]?.key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signers.currentUserNonce).toBeTypeOf("number");
    expect(signers.requesterFidNonces).toEqual({ [String(APPS[0].fid)]: 0 });
  });

  it("idRegistryEventByAddress: the custody address of fid 1, undefined for a stranger", async () => {
    const { api } = await client();
    const me = mnemonicToAccount(TEST_MNEMONIC).address;
    expect((await api.idRegistryEventByAddress(me))?.fid).toBe(ME_FID);
    const stranger = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 9 }).address;
    expect(await api.idRegistryEventByAddress(stranger)).toBeUndefined();
  });

  it("storageLimitsByFid: units and per-store limits", async () => {
    const { api } = await client();
    const storage = await api.storageLimitsByFid(ME_FID);
    expect(storage.units).toBe(1);
    expect(storage.limits.map((l) => l.name)).toContain("CASTS");
  });

  it("userNameProofByName: the fid behind a name, undefined for one nobody holds", async () => {
    const { api } = await client();
    expect((await api.userNameProofByName("casty-test"))?.fid).toBe(ME_FID);
    expect(await api.userNameProofByName("nobody-here")).toBeUndefined();
  });
});

describe("writes", () => {
  it("submitMessage returns the message JSON, and the cast can be read back", async () => {
    const { api } = await client();
    const cast = await buildCast(AUTHOR, { text: "from the client" }, authorSigner());
    const echoed = await api.submitMessage(Message.encode(cast).finish());
    expect(echoed.data.castAddBody?.text).toBe("from the client");
    expect((await api.castById(AUTHOR, echoed.hash))?.hash).toBe(echoed.hash);
  });

  it("castsByFid leaves out the remove a deleted cast leaves behind", async () => {
    const { api } = await client();
    const [cast] = (await api.castsByFid(AUTHOR)).items;
    if (!cast) throw new Error("fixture has no casts");
    const remove = await buildCastRemove(
      AUTHOR,
      Buffer.from(cast.hash.slice(2), "hex"),
      authorSigner(),
    );
    await api.submitMessage(Message.encode(remove).finish());
    const { items } = await api.castsByFid(AUTHOR);
    expect(items.map((m) => m.hash)).not.toContain(cast.hash);
    expect(items.every((m) => m.data.castAddBody)).toBe(true);
  });

  it("turns a node rejection into a NodeError with exit code 3", async () => {
    const { api } = await client();
    const target = { fid: AUTHOR, hash: new Uint8Array(20) };
    const stranger = new NobleEd25519Signer(new Uint8Array(32).fill(1));
    const like = await buildReaction("add", AUTHOR, ReactionType.LIKE, target, stranger);
    const rejected = api.submitMessage(Message.encode(like).finish());
    await expect(rejected).rejects.toThrow(NodeError);
    await expect(rejected).rejects.toMatchObject({ exitCode: 3, message: "invalid signer" });
  });
});

it("reports an unreachable node with exit code 4", async () => {
  const api = nodeClient("http://127.0.0.1:9");
  const failure = api.info();
  await expect(failure).rejects.toThrow(NodeUnreachableError);
  await expect(failure).rejects.toMatchObject({ exitCode: 4 });
});

it("says so when the URL answers 200 with something that is not the node's JSON", async () => {
  const page = createServer((_req, res) => res.end("<html>a web page</html>"));
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const { port } = page.address() as { port: number };
  try {
    const error = await nodeClient(`http://127.0.0.1:${port}`)
      .info()
      .catch((e) => e);
    expect(error).toBeInstanceOf(NodeError);
    expect(error.message).toContain("not JSON");
  } finally {
    page.close();
  }
});

describe("queries that span accounts", () => {
  // Snapchain 0.14 answers castsByMention and castsByParent with pageSize items from each shard,
  // one shard's run after the other (seen on a mainnet node), so a page is not in time order.
  // The mock's shards are fid parities: fid 100 and fid 101 land on different ones.
  const hashes = (items: NodeMessage[]) => items.map((c) => c.hash.slice(-2));

  it("castsByMention: a page comes out newest first here, whatever order the shards came in", async () => {
    const { node, api } = await client();
    const hi = (fid: number, t: number, hash: string) =>
      cast(fid, FIXTURE_TIME + t, hash, {
        castAddBody: { text: "hi", mentions: [ME_FID], mentionsPositions: [0], embeds: [] },
      });
    node.state.casts.push(
      ...([hi(100, 40, "e1"), hi(100, 30, "e2"), hi(101, 35, "o1"), hi(101, 25, "o2")] as never[]),
    );
    const { items } = await api.castsByMention(ME_FID, { reverse: true, pageSize: 2 });
    expect(hashes(items)).toEqual(["e1", "o1", "e2", "o2"]);
  });

  it("castsByParent: oldest first without reverse", async () => {
    const { node, api } = await client();
    const inChannel = (fid: number, t: number, hash: string) =>
      cast(fid, t, hash, {
        castAddBody: {
          text: "c",
          mentions: [],
          mentionsPositions: [],
          embeds: [],
          parentUrl: CHANNEL_URL,
        },
      });
    node.state.casts.push(
      ...([
        inChannel(100, 10, "e1"),
        inChannel(100, 30, "e2"),
        inChannel(101, 20, "o1"),
        inChannel(101, 40, "o2"),
      ] as never[]),
    );
    const { items } = await api.castsByParent({ url: CHANNEL_URL }, { pageSize: 2 });
    expect(hashes(items)).toEqual(["e1", "o1", "e2", "o2"]);
  });
});

// A mainnet node reads requesterFids[0]=1 as a list and silently ignores requesterFids%5B0%5D=1,
// which would leave every requester nonce at 0.
it("sends requester fids with the brackets raw, as a node reads a list", async () => {
  let url = "";
  const node = createServer((req, res) => {
    url = req.url ?? "";
    res.end(JSON.stringify({ signers: [], requesterFidNonces: {} }));
  });
  await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
  const { port } = node.address() as { port: number };
  try {
    await nodeClient(`http://127.0.0.1:${port}`).signersByFid(7, [8, 9]);
    expect(url).toBe("/v1/signersByFid?fid=7&requesterFids[0]=8&requesterFids[1]=9");
  } finally {
    node.close();
  }
});

// A mainnet node takes about 24 s to answer not found for an address it has never seen; at the
// usual 15 s that would read as an unreachable node, not as "no fid is registered".
it("gives the address-to-fid lookup a minute, since a node is slow to say not found", async () => {
  const { api } = await client();
  const timeouts: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    timeouts.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    await api.idRegistryEventByAddress("0x000000000000000000000000000000000000dEaD");
  } finally {
    AbortSignal.timeout = original;
  }
  expect(timeouts).toEqual([60_000]);
});
