import {
  FarcasterNetwork,
  getFarcasterTime,
  MessageType,
  makeKeyAdd,
  makeKeyAddBody,
  makeLinkAdd,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
} from "@farcaster/core";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { TEST_MNEMONIC } from "../src/index.js";
import { AUTHOR, authorSigner, castBy, getJson, ME, resign, startNode, submit } from "./helpers.js";

const NETWORK = { fid: ME, network: FarcasterNetwork.MAINNET };
const custody = new ViemLocalEip712Signer(mnemonicToAccount(TEST_MNEMONIC));

async function keyAddFor(
  scopes: MessageType[],
  nonce: number,
  privkey = new Uint8Array(32).fill(5),
) {
  const key = new NobleEd25519Signer(privkey);
  const pubkey = (await key.getSignerKey())._unsafeUnwrap();
  const deadline = getFarcasterTime()._unsafeUnwrap() + 3600;
  const options = { fid: BigInt(ME), key: pubkey, scopes, ttl: 3600, nonce, deadline };
  const body = (await makeKeyAddBody(options, custody))._unsafeUnwrap();
  return { message: (await makeKeyAdd(body, NETWORK, key))._unsafeUnwrap(), key, pubkey };
}

describe("reads", () => {
  it("reports three shards on /v1/info, with u32::MAX mempool on message shards", async () => {
    const node = await startNode();
    const { body } = await getJson(node, "/v1/info");
    expect(body.numShards).toBe(2);
    expect(body.shardInfos.map((s: { shardId: number }) => s.shardId)).toEqual([0, 1, 2]);
    expect(body.shardInfos[1].mempoolSize).toBe(4294967295);
    expect(typeof body.version).toBe("string");
  });

  it("encodes hashes and keys as 0x hex and signatures as base64, like the real node", async () => {
    const node = await startNode();
    const { body } = await getJson(node, `/v1/castsByFid?fid=${AUTHOR}`);
    const cast = body.messages[0];
    expect(cast.hash).toMatch(/^0x[0-9a-f]{40}$/);
    expect(cast.signer).toMatch(/^0x[0-9a-f]{64}$/);
    expect(cast.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(cast.data.type).toBe("MESSAGE_TYPE_CAST_ADD");
    expect(cast).not.toHaveProperty("dataBytes");
  });

  it("pages with base64 index tokens and an empty token at the end", async () => {
    const node = await startNode();
    const first = await getJson(node, `/v1/castsByFid?fid=${AUTHOR}&pageSize=3`);
    expect(first.body.messages).toHaveLength(3);
    expect(Buffer.from(first.body.nextPageToken, "base64").toString()).toBe("3");
    const rest = await getJson(
      node,
      `/v1/castsByFid?fid=${AUTHOR}&pageSize=3&pageToken=${first.body.nextPageToken}`,
    );
    expect(rest.body.messages).toHaveLength(1);
    expect(rest.body.nextPageToken).toBe("");
  });

  it("orders oldest first, newest first with reverse", async () => {
    const node = await startNode();
    const ts = (b: { messages: { data: { timestamp: number } }[] }) =>
      b.messages.map((m) => m.data.timestamp);
    const asc = ts((await getJson(node, `/v1/castsByFid?fid=${AUTHOR}`)).body);
    const desc = ts((await getJson(node, `/v1/castsByFid?fid=${AUTHOR}&reverse=true`)).body);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(desc).toEqual([...asc].reverse());
  });

  it("answers unknown casts as Snapchain does: HTTP 400 with NotFound in error_detail", async () => {
    const node = await startNode();
    const { status, body } = await getJson(
      node,
      `/v1/castById?fid=${AUTHOR}&hash=0x${"00".repeat(20)}`,
    );
    expect(status).toBe(400);
    expect(body.errCode).toBeUndefined();
    expect(body.error_detail).toMatch(/^status: NotFound, message: ".*", details: \[\]/);
  });

  it("pages castsByMention per shard, as Snapchain does: pageSize from each shard, one run after the other", async () => {
    const node = await startNode();
    const { body } = await getJson(node, `/v1/castsByMention?fid=${ME}&reverse=true&pageSize=1`);
    expect(body.messages.length).toBe(2);
    expect(new Set(body.messages.map((m: { data: { fid: number } }) => m.data.fid % 2)).size).toBe(
      2,
    );
    expect(JSON.parse(Buffer.from(body.nextPageToken, "base64").toString())).toHaveLength(2);
  });

  it("rejects a missing required parameter with a validation error", async () => {
    const node = await startNode();
    const { status, body } = await getJson(node, "/v1/castsByFid");
    expect(status).toBe(400);
    expect(body.errCode).toBe("bad_request.validation_failure");
  });

  it("maps the test custody address to fid 1", async () => {
    const node = await startNode();
    const address = mnemonicToAccount(TEST_MNEMONIC).address.toLowerCase();
    const { body } = await getJson(node, `/v1/onChainIdRegistryEventByAddress?address=${address}`);
    expect(body.fid).toBe(ME);
    expect(body.idRegisterEventBody.to).toBe(address);
  });

  it("pages every user data type for userDataByFid, with or without user_data_type", async () => {
    const node = await startNode();
    const typed = await getJson(
      node,
      `/v1/userDataByFid?fid=${ME}&user_data_type=USER_DATA_TYPE_USERNAME`,
    );
    const all = await getJson(node, `/v1/userDataByFid?fid=${ME}`);
    expect(typed.body).toEqual(all.body);
    expect(all.body.messages[0].data.userDataBody.value).toBe("casty-test");
  });
});

describe("submitMessage", () => {
  it("accepts a cast signed by an active key and serves it back", async () => {
    const node = await startNode();
    const cast = await castBy(authorSigner(), "fresh");
    const { status, body } = await submit(node, cast);
    expect(status).toBe(200);
    const read = await getJson(node, `/v1/castById?fid=${AUTHOR}&hash=${body.hash}`);
    expect(read.body.data.castAddBody.text).toBe("fresh");
  });

  it("rejects a bad signature", async () => {
    const node = await startNode();
    const cast = await castBy(authorSigner());
    cast.signature[0] = (cast.signature[0] ?? 0) ^ 1;
    const { status, body } = await submit(node, cast);
    expect(status).toBe(400);
    expect(body.details).toMatch(/signature/);
  });

  it("rejects a key that is not registered to the fid", async () => {
    const node = await startNode();
    const { status, body } = await submit(
      node,
      await castBy(new NobleEd25519Signer(new Uint8Array(32).fill(3))),
    );
    expect(status).toBe(400);
    expect(body.details).toBe("invalid signer");
  });

  it("adds a gasless key, then refuses a message type outside its scopes", async () => {
    const node = await startNode();
    const { message, key, pubkey } = await keyAddFor([MessageType.CAST_ADD], 1);
    expect((await submit(node, message)).status).toBe(200);
    const signers = await getJson(node, `/v1/signersByFid?fid=${ME}`);
    expect(signers.body.currentUserNonce).toBe(1);
    expect(signers.body.signers.map((s: { key: string }) => s.key)).toContain(bytesToHex(pubkey));

    const link = await makeLinkAdd({ type: "follow", targetFid: AUTHOR }, NETWORK, key);
    const { status, body } = await submit(node, link._unsafeUnwrap());
    expect(status).toBe(400);
    expect(body.details).toBe("invalid scope");
  });

  it("rejects a KEY_ADD whose nonce does not exceed the stored one", async () => {
    const node = await startNode();
    expect((await submit(node, (await keyAddFor([MessageType.CAST_ADD], 1)).message)).status).toBe(
      200,
    );
    const again = await keyAddFor([MessageType.CAST_ADD], 1, new Uint8Array(32).fill(6));
    const { status, body } = await submit(node, again.message);
    expect(status).toBe(400);
    expect(body.details).toBe("nonce is not greater than stored nonce");
  });

  it("rejects a KEY_ADD signed by the wrong custody address", async () => {
    const node = await startNode();
    const other = new ViemLocalEip712Signer(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 }));
    const key = new NobleEd25519Signer(new Uint8Array(32).fill(5));
    const pubkey = (await key.getSignerKey())._unsafeUnwrap();
    const deadline = getFarcasterTime()._unsafeUnwrap() + 3600;
    const options = {
      fid: BigInt(ME),
      key: pubkey,
      scopes: [MessageType.CAST_ADD],
      ttl: 60,
      nonce: 1,
      deadline,
    };
    const body = (await makeKeyAddBody(options, other))._unsafeUnwrap();
    const res = await submit(node, (await makeKeyAdd(body, NETWORK, key))._unsafeUnwrap());
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("invalid signature");
  });

  it("rejects a KEY_ADD that asks for an inadmissible scope", async () => {
    const node = await startNode();
    const { message, key } = await keyAddFor([MessageType.CAST_ADD], 1);
    const tampered = await resign(message, key, (data) => {
      if (data.keyAddBody) data.keyAddBody.scopes = [MessageType.KEY_ADD];
    });
    const { status, body } = await submit(node, tampered);
    expect(status).toBe(400);
    expect(body.details).toBe("invalid scope");
  });
});

describe("control", () => {
  it("delays merges by mergeDelayMs", async () => {
    const node = await startNode();
    node.control({ mergeDelayMs: 150 });
    const { body } = await submit(node, await castBy(authorSigner(), "slow"));
    const path = `/v1/castById?fid=${AUTHOR}&hash=${body.hash}`;
    expect((await getJson(node, path)).status).toBe(400);
    await vi.waitFor(async () => expect((await getJson(node, path)).status).toBe(200));
  });

  it("accepts and silently drops the next submit with dropNextSubmit", async () => {
    const node = await startNode();
    node.control({ dropNextSubmit: true });
    const first = await submit(node, await castBy(authorSigner(), "lost"));
    expect(first.status).toBe(200);
    expect((await getJson(node, `/v1/castById?fid=${AUTHOR}&hash=${first.body.hash}`)).status).toBe(
      400,
    );
    const second = await submit(node, await castBy(authorSigner(), "kept"));
    expect(
      (await getJson(node, `/v1/castById?fid=${AUTHOR}&hash=${second.body.hash}`)).status,
    ).toBe(200);
  });

  it.each([
    ["nonce", "nonce is not greater than stored nonce"],
    ["scope", "invalid scope"],
    ["signature", "invalid signature"],
  ])("rejects the next submit with %s", async (kind, details) => {
    const node = await startNode();
    await fetch(`${node.url}/__mock/control`, {
      method: "POST",
      body: JSON.stringify({ rejectNextWith: kind }),
    });
    const res = await submit(node, await castBy(authorSigner()));
    expect(res.status).toBe(400);
    expect(res.body.details).toBe(details);
    expect((await submit(node, await castBy(authorSigner(), "next"))).status).toBe(200);
  });

  it("answers the next submit with 503 when told the node is unavailable", async () => {
    const node = await startNode();
    node.control({ rejectNextWith: "unavailable" });
    const res = await submit(node, await castBy(authorSigner()));
    expect(res.status).toBe(503);
    expect((await submit(node, await castBy(authorSigner(), "next"))).status).toBe(200);
  });

  it("answers /v1/info with 503 as many times as infoUnavailable says", async () => {
    const node = await startNode();
    node.control({ infoUnavailable: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${node.url}/v1/info`)).status);
    expect(statuses).toEqual([503, 503, 200]);
  });

  it("fails reads with 503 after a submit lands, as many as failReadsAfterSubmit says", async () => {
    const node = await startNode();
    node.control({ failReadsAfterSubmit: 2 });
    expect((await getJson(node, `/v1/castsByFid?fid=${AUTHOR}`)).status).toBe(200);
    const cast = await castBy(authorSigner(), "lands, then reads fail");
    expect((await submit(node, cast)).status).toBe(200);
    const hash = bytesToHex(cast.hash);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await getJson(node, `/v1/castById?fid=${AUTHOR}&hash=${hash}`)).status);
    }
    expect(statuses).toEqual([503, 503, 200]);
  });

  it("walks the blockDelay sequence one /v1/info call at a time, then holds the last value", async () => {
    const node = await startNode();
    node.control({ blockDelay: [5000, 400, 3] });
    const delays = [];
    for (let i = 0; i < 4; i++) {
      const { body } = await getJson(node, "/v1/info");
      delays.push(body.shardInfos.map((s: { blockDelay: number }) => s.blockDelay));
    }
    expect(delays).toEqual([
      [5000, 5000, 5000],
      [400, 400, 400],
      [3, 3, 3],
      [3, 3, 3],
    ]);
  });

  it("counts requests in flight when latency is added", async () => {
    const node = await startNode();
    node.control({ latencyMs: 30 });
    await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${node.url}/v1/castsByFid?fid=${AUTHOR}`)),
    );
    expect(node.state.stats.maxInFlight).toBe(5);
  });

  it("rejects unknown control keys", async () => {
    const node = await startNode();
    const res = await fetch(`${node.url}/__mock/control`, {
      method: "POST",
      body: JSON.stringify({ nope: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("dumps counts on /__mock/state", async () => {
    const node = await startNode();
    const { body } = await getJson(node, "/__mock/state");
    expect(body.casts).toBe(48);
    expect(body.fids).toBeGreaterThan(12);
  });
});

describe("events", () => {
  it("lists merges as events of shard 1, newest last, and shard 2 has none", async () => {
    const node = await startNode();
    await submit(node, await castBy(authorSigner(), "first"));
    await submit(node, await castBy(authorSigner(), "second"));
    const { body } = await getJson(node, "/v1/events?shard_index=1&from_event_id=0");
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({
      type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
      id: 1,
      shardIndex: 1,
      blockNumber: expect.any(Number),
    });
    expect(body.events[1].mergeMessageBody.message.data.castAddBody.text).toBe("second");
    expect((await getJson(node, "/v1/events?shard_index=2&from_event_id=0")).body.events).toEqual(
      [],
    );
    const newest = await getJson(node, "/v1/events?shard_index=1&reverse=true&pageSize=1");
    expect(newest.body.events.map((e: { id: number }) => e.id)).toEqual([2]);
    const from = await getJson(node, "/v1/events?shard_index=1&from_event_id=2");
    expect(from.body.events.map((e: { id: number }) => e.id)).toEqual([2]);
  });

  it("merges the casts emitEvents hands it as if they had arrived by gossip, unsigned", async () => {
    const node = await startNode();
    const stranger = ME + 5000;
    const cast = {
      data: {
        type: "MESSAGE_TYPE_CAST_ADD",
        fid: stranger,
        timestamp: 100,
        network: "FARCASTER_NETWORK_MAINNET",
        castAddBody: { text: "gossiped", mentions: [ME], mentionsPositions: [0], embeds: [] },
      },
      hash: `0x${"ab".repeat(20)}`,
      hashScheme: "HASH_SCHEME_BLAKE3",
      signature: "",
      signatureScheme: "SIGNATURE_SCHEME_ED25519",
      signer: `0x${"11".repeat(32)}`,
    };
    node.control({ emitEvents: [cast] });
    const { body } = await getJson(node, `/v1/castsByFid?fid=${stranger}`);
    expect(body.messages[0].data.castAddBody.text).toBe("gossiped");
    const events = await getJson(node, "/v1/events?shard_index=1&from_event_id=0");
    expect(events.body.events[0].mergeMessageBody.message.hash).toBe(cast.hash);
    const mentions = await getJson(node, `/v1/castsByMention?fid=${ME}`);
    expect(mentions.body.messages.map((m: { hash: string }) => m.hash)).toContain(cast.hash);
  });
});

describe("verifications", () => {
  it("lists an account's verified addresses as hex, with the protocol", async () => {
    const node = await startNode();
    const { body } = await getJson(node, `/v1/verificationsByFid?fid=${AUTHOR}`);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].data.verificationAddAddressBody).toMatchObject({
      address: expect.stringMatching(/^0x[0-9a-f]{40}$/),
      protocol: "PROTOCOL_ETHEREUM",
    });
    expect((await getJson(node, `/v1/verificationsByFid?fid=${AUTHOR + 1}`)).body.messages).toEqual(
      [],
    );
  });
});
