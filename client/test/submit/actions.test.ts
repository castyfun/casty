import { fixtureKey, ME_FID } from "@casty/mock-node";
import { NobleEd25519Signer } from "@farcaster/core";
import { expect, it } from "vitest";
import { NodeUnreachableError } from "../../src/node/errors.js";
import { type NodeClient, nodeClient } from "../../src/node/http.js";
import { follow, postCast } from "../../src/submit/actions.js";
import { startMock } from "../mock.js";

async function writer(change: (node: NodeClient) => NodeClient = (n) => n) {
  const mock = await startMock();
  const node = change(nodeClient(mock.url));
  const signer = new NobleEd25519Signer(fixtureKey(42, ME_FID));
  return { mock, w: { node, fid: ME_FID, signer, confirm: { timeoutMs: 300, pollMs: 10 } } };
}

it("returns the cast's farcaster.xyz link", async () => {
  const { mock, w } = await writer();
  const { hash, url } = await postCast(w, { text: "with a link back" });
  expect(mock.state.casts.some((c) => c.hash === hash)).toBe(true);
  expect(url).toMatch(/^https:\/\/farcaster\.xyz\/casty-test\/0x/);
});

it("still reports a published cast when the username cannot be read", async () => {
  const { mock, w } = await writer((node) => ({
    ...node,
    userDataByFid: async () => {
      throw new NodeUnreachableError(node.url);
    },
  }));
  const { hash, url } = await postCast(w, { text: "published all the same" });
  expect(mock.state.casts.some((c) => c.hash === hash)).toBe(true);
  expect(url).toBeNull();
});

it("confirms a follow with one read of that link, not by paging the whole follow list", async () => {
  let pagedFollows = 0;
  const { mock, w } = await writer((node) => ({
    ...node,
    linksByFid: (...args: Parameters<NodeClient["linksByFid"]>) => {
      pagedFollows++;
      return node.linksByFid(...args);
    },
  }));
  const target = mock.state.links.find((l) => l.data.fid === ME_FID)?.data.linkBody?.targetFid;
  if (target === undefined) throw new Error("fixture fid 1 follows nobody");
  await follow(w, "remove", target);
  await follow(w, "add", target);
  expect(pagedFollows).toBe(0);
  expect(
    mock.state.links.some((l) => l.data.fid === ME_FID && l.data.linkBody?.targetFid === target),
  ).toBe(true);
});
