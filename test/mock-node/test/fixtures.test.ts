import { Message, validations } from "@farcaster/core";
import { describe, expect, it } from "vitest";
import { generateFixtures, loadFixtures, messageFromWire } from "../src/index.js";
import { SEED } from "./helpers.js";

const BASIC = { fids: 12, casts: 4, seed: SEED };

describe("generateFixtures", () => {
  it("is deterministic for a seed", async () => {
    const a = JSON.stringify(await generateFixtures(BASIC));
    const b = JSON.stringify(await generateFixtures(BASIC));
    expect(a).toBe(b);
  });

  it("changes with the seed", async () => {
    const a = JSON.stringify(await generateFixtures(BASIC));
    const b = JSON.stringify(await generateFixtures({ ...BASIC, seed: SEED + 1 }));
    expect(a).not.toBe(b);
  });

  it("matches the committed basic set, so the files never drift from the generator", async () => {
    expect(loadFixtures("basic")).toEqual(await generateFixtures(BASIC));
  });

  it("produces the requested number of authors and casts", async () => {
    const f = await generateFixtures({ fids: 3, casts: 2, seed: 1 });
    const authors = new Set(f.casts.map((c) => c.data.fid));
    expect(authors.size).toBe(3);
    expect(f.casts).toHaveLength(6);
  });

  it("uses only fids far above any registered account, so no real person appears", async () => {
    const f = await generateFixtures({ fids: 3, casts: 1, seed: 1 });
    const fids = [...f.fids, ...f.casts.map((c) => c.data.fid), ...f.onchain.map((e) => e.fid)];
    expect(Math.min(...fids)).toBeGreaterThanOrEqual(2_000_000_000);
    expect(Math.max(...fids)).toBeLessThan(2 ** 31);
  });

  it("signs every message for real", async () => {
    const f = loadFixtures("basic");
    for (const wire of [
      ...f.casts,
      ...f.links,
      ...f.reactions,
      ...f.userdata,
      ...f.verifications,
    ]) {
      const message = messageFromWire(wire);
      expect(Message.decode(Message.encode(message).finish()).hash).toEqual(message.hash);
      expect((await validations.validateMessage(message)).isOk()).toBe(true);
    }
  });
});
