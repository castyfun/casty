import { FIRST_AUTHOR, ME_FID } from "@casty/mock-node";
import { expect, it } from "vitest";
import { startMock } from "../mock.js";
import { casty, flags, initMe, tempConfig } from "./harness.js";

const AUTHOR = String(FIRST_AUTHOR);
const THREE_AUTHORS = [0, 1, 2].map((i) => FIRST_AUTHOR + i).join(",");

it("doctor --json", async () => {
  const node = await startMock();
  const { code, stdout } = await casty([
    "doctor",
    "--json",
    ...flags(node.url, "/nonexistent/casty"),
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchSnapshot({
    node: expect.any(String),
    clockSkewSeconds: expect.any(Number),
  });
});

it("whoami --json", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  const { code, stdout } = await casty(["whoami", "--json", ...flags(node.url, dir)]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchSnapshot({
    activeKey: expect.stringMatching(/^0x[0-9a-f]{64}$/),
  });
});

it("feed --json", async () => {
  const node = await startMock();
  const { code, stdout } = await casty([
    "feed",
    "--json",
    "--limit",
    "3",
    "--fids",
    THREE_AUTHORS,
    ...flags(node.url, tempConfig()),
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchSnapshot();
});

it("clients --json", async () => {
  const node = await startMock();
  const { code, stdout } = await casty([
    "clients",
    "--json",
    "--fid",
    AUTHOR,
    ...flags(node.url, tempConfig()),
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchSnapshot();
});

it("storage --json", async () => {
  const node = await startMock();
  const { code, stdout } = await casty([
    "storage",
    "--json",
    "--fid",
    String(ME_FID),
    ...flags(node.url, tempConfig()),
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchSnapshot();
});
