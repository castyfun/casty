import { createMockNode, type MockNode, type MockNodeOptions } from "@casty/mock-node";
import { afterEach } from "vitest";

const running: MockNode[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((node) => node.close()));
});

/** An in-process mock node, closed after the current test. */
export async function startMock(options: MockNodeOptions = {}): Promise<MockNode> {
  const node = await createMockNode(options);
  running.push(node);
  return node;
}
