import { FIRST_AUTHOR } from "@casty/mock-node";
import { expect, it } from "vitest";
import { describeCasts } from "../../src/feed/feed.js";
import { type NodeClient, nodeClient } from "../../src/node/http.js";
import { startMock } from "../mock.js";

it("asks for people's names while their signers are still being read", async () => {
  const api = nodeClient((await startMock()).url);
  const casts = (await api.castsByFid(FIRST_AUTHOR, { reverse: true, pageSize: 3 })).items;
  // The signers answer only once a name has been asked for: one after the other never ends.
  let nameAsked = () => {};
  const asked = new Promise<void>((resolve) => {
    nameAsked = resolve;
  });
  const node = {
    ...api,
    signersByFid: async (...args: Parameters<NodeClient["signersByFid"]>) => {
      await asked;
      return api.signersByFid(...args);
    },
    userDataByFid: (...args: Parameters<NodeClient["userDataByFid"]>) => {
      nameAsked();
      return api.userDataByFid(...args);
    },
  } as NodeClient;
  const items = await describeCasts(node, casts, {});
  expect(items[0]?.author).toBeTruthy();
  expect(items[0]?.app).not.toBeNull();
}, 3000);
