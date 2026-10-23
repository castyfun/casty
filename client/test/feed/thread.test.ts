import { expect, it } from "vitest";
import { readThread } from "../../src/feed/feed.js";
import type { NodeClient, NodeMessage } from "../../src/node/http.js";

const cast = (hash: string, timestamp: number) =>
  ({ hash, data: { fid: 1, timestamp, castAddBody: { text: hash } } }) as unknown as NodeMessage;

it("lists a thread's replies oldest first, whatever order the node gives them in", async () => {
  const node = {
    castById: async () => cast("0xa", 10),
    castsByParent: async () => ({ items: [cast("0xc", 30), cast("0xb", 20)], nextPageToken: "" }),
  } as unknown as NodeClient;
  const thread = await readThread(node, { fid: 1, hash: "0xa" });
  expect(thread?.replies.map((r) => r.hash)).toEqual(["0xb", "0xc"]);
});
