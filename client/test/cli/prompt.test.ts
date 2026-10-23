import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readFirstLine } from "../../src/cli/prompt.js";

it("returns the first line and zeroes every chunk it read", async () => {
  const chunks = [Buffer.from("test test "), Buffer.from("junk\nmore")];
  const line = await readFirstLine(Readable.from(chunks));
  expect(new TextDecoder().decode(line)).toBe("test test junk");
  for (const chunk of chunks) expect(chunk.every((b) => b === 0)).toBe(true);
});
