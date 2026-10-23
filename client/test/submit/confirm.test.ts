import { FIRST_AUTHOR, fixtureKey } from "@casty/mock-node";
import { type Message, NobleEd25519Signer } from "@farcaster/core";
import { bytesToHex } from "viem";
import { expect, it } from "vitest";
import { NodeUnreachableError, NonceError, NotMergedError } from "../../src/node/errors.js";
import { nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { submitAndConfirm } from "../../src/submit/confirm.js";
import { startMock } from "../mock.js";

const AUTHOR = FIRST_AUTHOR;
const FAST = { timeoutMs: 150, pollMs: 10 };

async function setup(text: string) {
  const node = await startMock();
  const api = nodeClient(node.url);
  const cast = await buildCast(AUTHOR, { text }, new NobleEd25519Signer(fixtureKey(42, AUTHOR)));
  const merged = async () => (await api.castById(AUTHOR, bytesToHex(cast.hash))) !== undefined;
  return { node, api, cast, merged };
}

const run = (s: {
  api: ReturnType<typeof nodeClient>;
  cast: Message;
  merged: () => Promise<boolean>;
}) => submitAndConfirm(s.api, s.cast, s.merged, FAST);

it("returns once the message is merged", async () => {
  const s = await setup("now");
  expect((await run(s)).hash).toBe(bytesToHex(s.cast.hash));
  expect(await s.merged()).toBe(true);
  expect(s.node.state.stats.submits).toBe(1);
});

it("keeps polling while the merge is delayed", async () => {
  const s = await setup("later");
  s.node.control({ mergeDelayMs: 60 });
  await run(s);
  expect(s.node.state.stats.submits).toBe(1);
});

it("resubmits the same message once when gossip dropped it", async () => {
  const s = await setup("dropped");
  s.node.control({ dropNextSubmit: true });
  await run(s);
  expect(s.node.state.stats.submits).toBe(2);
  expect(await s.merged()).toBe(true);
});

it("says the message may still merge when the node is gone by the resubmit, so a rerun is no duplicate", async () => {
  const s = await setup("tunnel dropped");
  s.node.control({ mergeDelayMs: 60_000 });
  let submits = 0;
  const api = {
    ...s.api,
    submitMessage: (bytes: Uint8Array) => {
      if (submits++ === 0) return s.api.submitMessage(bytes);
      throw new NodeUnreachableError(s.node.url);
    },
  };
  const outcome = submitAndConfirm(api, s.cast, s.merged, FAST);
  await expect(outcome).rejects.toThrow(NotMergedError);
  await expect(outcome).rejects.toMatchObject({ hint: expect.stringContaining("read node") });
});

it("gives up with NotMergedError, explaining read-node relay", async () => {
  const s = await setup("never");
  s.node.control({ mergeDelayMs: 60_000 });
  const outcome = run(s);
  await expect(outcome).rejects.toThrow(NotMergedError);
  await expect(outcome).rejects.toMatchObject({
    exitCode: 3,
    hint: expect.stringContaining("read node"),
  });
  expect(s.node.state.stats.submits).toBe(2);
});

it("does not resubmit a message the node rejected", async () => {
  const s = await setup("rejected");
  s.node.control({ rejectNextWith: "nonce" });
  await expect(run(s)).rejects.toThrow(NonceError);
  expect(s.node.state.stats.submits).toBe(1);
});

it("succeeds when the resubmit is refused because the first copy merged meanwhile", async () => {
  const s = await setup("merged late");
  // Unseen until the resubmit, which the node then refuses, as it refuses a message it has.
  const confirm = async () => {
    if (s.node.state.stats.submits < 2) {
      s.node.control({ rejectNextWith: "nonce" });
      return false;
    }
    return s.merged();
  };
  const accepted = await submitAndConfirm(s.api, s.cast, confirm, FAST);
  expect(accepted.hash).toBe(bytesToHex(s.cast.hash));
  expect(s.node.state.stats.submits).toBe(2);
});

it("calls a refused resubmit not merged, since the first copy may still land", async () => {
  const s = await setup("refused copy");
  s.node.control({ dropNextSubmit: true });
  const confirm = async () => {
    s.node.control({ rejectNextWith: "nonce" });
    return false;
  };
  await expect(submitAndConfirm(s.api, s.cast, confirm, FAST)).rejects.toThrow(NotMergedError);
  expect(s.node.state.stats.submits).toBe(2);
});

it("treats a check that fails while waiting as not merged yet, not as a failed write", async () => {
  const s = await setup("checked through a hiccup");
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new NonceError("the node is too busy to answer");
    return s.merged();
  };
  expect((await submitAndConfirm(s.api, s.cast, flaky, FAST)).hash).toBe(bytesToHex(s.cast.hash));
  expect(await s.merged()).toBe(true);
});
