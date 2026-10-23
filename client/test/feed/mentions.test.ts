import { FIRST_AUTHOR, fixtureKey, ME_FID } from "@casty/mock-node";
import { Message, NobleEd25519Signer } from "@farcaster/core";
import { expect, it } from "vitest";
import { loadMentions } from "../../src/feed/feed.js";
import { nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { startMock } from "../mock.js";

/** Signs and submits a cast as a fixture account, as that account's app would. */
async function castAs(
  api: ReturnType<typeof nodeClient>,
  fid: number,
  input: Parameters<typeof buildCast>[1],
) {
  const cast = await buildCast(fid, input, new NobleEd25519Signer(fixtureKey(42, fid)));
  await api.submitMessage(Message.encode(cast).finish());
  return cast;
}

it("lists the casts that mention you, newest first", async () => {
  const api = nodeClient((await startMock()).url);
  const items = await loadMentions(api, { fid: ME_FID, limit: 10 });
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((i) => i.mentions.some((m) => m.fid === ME_FID))).toBe(true);
  const times = items.map((i) => i.timestamp);
  expect(times).toEqual(times.toSorted((a, b) => b - a));
});

it("adds the replies to your casts, but not your own", async () => {
  const api = nodeClient((await startMock()).url);
  const mine = await castAs(api, ME_FID, { text: "anyone here?" });
  const parent = { fid: ME_FID, hash: mine.hash };
  const reply = await castAs(api, FIRST_AUTHOR, { text: "here", parent });
  await castAs(api, ME_FID, { text: "talking to myself", parent });
  const items = await loadMentions(api, { fid: ME_FID, limit: 50 });
  const hashes = items.map((i) => i.hash);
  expect(hashes).toContain(`0x${Buffer.from(reply.hash).toString("hex")}`);
  expect(items.every((i) => i.fid !== ME_FID)).toBe(true);
  expect(items.find((i) => i.text === "here")).toMatchObject({ parentAuthor: "casty-test" });
});

it("stops at the limit", async () => {
  const api = nodeClient((await startMock()).url);
  expect(await loadMentions(api, { fid: ME_FID, limit: 1 })).toHaveLength(1);
});
