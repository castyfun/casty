import {
  CastType,
  FARCASTER_EPOCH,
  Message,
  MessageType,
  ReactionType,
  validations,
} from "@farcaster/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/errors.js";
import {
  buildCast,
  buildCastRemove,
  buildLink,
  buildReaction,
  castTypeFor,
} from "../../src/protocol/messages.js";
import { fixedSigner } from "../helpers.js";

const FID = 2_000_001_234;
const NOW = new Date("2026-10-18T12:00:00Z");
const TARGET = { fid: 2_000_000_099, hash: new Uint8Array(20).fill(1) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function everyMessageType(): Promise<Message[]> {
  const { signer } = await fixedSigner();
  return [
    await buildCast(FID, { text: "hello" }, signer),
    await buildCastRemove(FID, TARGET.hash, signer),
    await buildReaction("add", FID, ReactionType.LIKE, TARGET, signer),
    await buildReaction("remove", FID, ReactionType.RECAST, TARGET, signer),
    await buildLink("add", FID, TARGET.fid, signer),
    await buildLink("remove", FID, TARGET.fid, signer),
  ];
}

describe("every builder", () => {
  it("produces messages that survive a protobuf round trip", async () => {
    for (const m of await everyMessageType()) {
      expect(Message.decode(Message.encode(m).finish())).toEqual(m);
    }
  });

  it("produces a 20-byte hash and a signature the library accepts", async () => {
    for (const m of await everyMessageType()) {
      expect(m.hash).toHaveLength(20);
      expect((await validations.validateMessage(m)).isOk()).toBe(true);
    }
  });

  it("is checked for real: a flipped signature byte fails validation", async () => {
    const [cast] = await everyMessageType();
    if (!cast) throw new Error("no message");
    cast.signature[0] = (cast.signature[0] ?? 0) ^ 1;
    expect((await validations.validateMessage(cast)).isErr()).toBe(true);
  });

  it("stamps Farcaster-epoch seconds, not unix seconds", async () => {
    for (const m of await everyMessageType()) {
      expect(m.data?.timestamp).toBe((NOW.getTime() - FARCASTER_EPOCH) / 1000);
    }
  });
});

describe("castTypeFor", () => {
  // "é" is two UTF-8 bytes, so these strings are short in characters but long in bytes.
  const bytes = (n: number) => "é".repeat(Math.floor(n / 2)) + "a".repeat(n % 2);

  it.each([319, 320])("keeps %i bytes a CAST", (n) => {
    expect(castTypeFor(bytes(n))).toBe(CastType.CAST);
  });

  it.each([321, 1023, 1024])("switches %i bytes to LONG_CAST", (n) => {
    expect(castTypeFor(bytes(n))).toBe(CastType.LONG_CAST);
  });

  it("rejects 1025 bytes", () => {
    expect(() => castTypeFor(bytes(1025))).toThrow(UsageError);
  });

  it("counts bytes, not characters", () => {
    expect(castTypeFor("a".repeat(320))).toBe(CastType.CAST);
    expect(castTypeFor("é".repeat(161))).toBe(CastType.LONG_CAST);
  });
});

describe("buildCast", () => {
  it("sends known @names as mentions the node-side validation accepts", async () => {
    const { signer } = await fixedSigner();
    const m = await buildCast(
      FID,
      { text: "gm @alice", mentions: new Map([["alice", 5]]) },
      signer,
    );
    expect(m.data?.castAddBody).toMatchObject({
      text: "gm ",
      mentions: [5],
      mentionsPositions: [3],
    });
    expect((await validations.validateMessage(m)).isOk()).toBe(true);
  });

  it("selects LONG_CAST for long text and the node-side validation accepts it", async () => {
    const { signer } = await fixedSigner();
    const m = await buildCast(FID, { text: "x".repeat(500) }, signer);
    expect(m.data?.castAddBody?.type).toBe(CastType.LONG_CAST);
    expect((await validations.validateMessage(m)).isOk()).toBe(true);
  });

  it("sets the parent cast for a reply and the parent url for a channel", async () => {
    const { signer } = await fixedSigner();
    const reply = await buildCast(FID, { text: "re", parent: TARGET }, signer);
    expect(reply.data?.castAddBody?.parentCastId).toEqual(TARGET);
    const channel = await buildCast(FID, { text: "hi", channel: "https://example.com/c" }, signer);
    expect(channel.data?.castAddBody?.parentUrl).toBe("https://example.com/c");
  });

  it("refuses a cast that is both a reply and a channel post", async () => {
    const { signer } = await fixedSigner();
    const input = { text: "x", parent: TARGET, channel: "https://example.com/c" };
    await expect(buildCast(FID, input, signer)).rejects.toThrow(UsageError);
  });

  it("puts embeds in as urls", async () => {
    const { signer } = await fixedSigner();
    const m = await buildCast(FID, { text: "see", embeds: ["https://example.com/a"] }, signer);
    expect(m.data?.castAddBody?.embeds).toEqual([{ url: "https://example.com/a" }]);
  });

  it("reports library validation failures as usage errors", async () => {
    const { signer } = await fixedSigner();
    await expect(buildCast(FID, { text: "" }, signer)).rejects.toThrow(UsageError);
  });

  it("types each message correctly", async () => {
    const types = (await everyMessageType()).map((m) => m.data?.type);
    expect(types).toEqual([
      MessageType.CAST_ADD,
      MessageType.CAST_REMOVE,
      MessageType.REACTION_ADD,
      MessageType.REACTION_REMOVE,
      MessageType.LINK_ADD,
      MessageType.LINK_REMOVE,
    ]);
  });
});
