import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FID_BASE, ME_FID, TEST_MNEMONIC } from "@casty/mock-node";
import { mnemonicToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { diskCache } from "../../src/config.js";
import { fidForAddress, fidForName } from "../../src/custody/fid.js";
import { ConfigError, UsageError } from "../../src/errors.js";
import { nodeClient } from "../../src/node/http.js";
import { startMock } from "../mock.js";

const me = mnemonicToAccount(TEST_MNEMONIC).address;
const stranger = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 7 }).address;
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A one-method OP Mainnet RPC that answers every eth_call with `idOf = fid`. */
async function fakeRpc(fid: number): Promise<string> {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { id, method } = JSON.parse(raw);
    const result = method === "eth_call" ? `0x${fid.toString(16).padStart(64, "0")}` : "0xa";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("finds the fid through the node's id registry events", async () => {
  const node = await startMock();
  expect(await fidForAddress(nodeClient(node.url), me)).toBe(ME_FID);
});

it("explains what to do when no fid is registered to the address", async () => {
  const node = await startMock();
  const lookup = fidForAddress(nodeClient(node.url), stranger);
  await expect(lookup).rejects.toThrow(ConfigError);
  await expect(lookup).rejects.toMatchObject({ hint: expect.stringContaining("--op-rpc") });
});

it("falls back to IdRegistry.idOf over --op-rpc", async () => {
  const node = await startMock();
  expect(await fidForAddress(nodeClient(node.url), stranger, await fakeRpc(FID_BASE + 4242))).toBe(
    FID_BASE + 4242,
  );
});

it("still fails when the IdRegistry says 0", async () => {
  const node = await startMock();
  await expect(fidForAddress(nodeClient(node.url), stranger, await fakeRpc(0))).rejects.toThrow(
    ConfigError,
  );
});

describe("fidForName", () => {
  /** Answers /transfers?name= like the fname registry: the latest transfer's `to` owns the name. */
  async function fakeFnames(owners: Record<string, number>): Promise<string> {
    const server = createServer((req, res) => {
      const name = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "";
      const transfers = owners[name] ? [{ to: 0 }, { to: owners[name] }] : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transfers }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => server.close());
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("asks the node first", async () => {
    const node = await startMock();
    expect(await fidForName(nodeClient(node.url), "@casty-test", undefined)).toBe(ME_FID);
    expect(await fidForName(nodeClient(node.url), "@Casty-Test", undefined)).toBe(ME_FID);
  });

  it("falls back to the fname server for names the node does not know", async () => {
    const node = await startMock();
    const server = await fakeFnames({ elsewhere: FID_BASE + 777 });
    expect(await fidForName(nodeClient(node.url), "elsewhere", server)).toBe(FID_BASE + 777);
  });

  it("caches what it found", async () => {
    const node = await startMock();
    const cache = diskCache<number>(undefined, "names", 60_000);
    await fidForName(
      nodeClient(node.url),
      "elsewhere",
      await fakeFnames({ elsewhere: FID_BASE + 777 }),
      cache,
    );
    expect(cache.get("elsewhere")).toBe(FID_BASE + 777);
  });

  it("is a usage error when nobody knows the name", async () => {
    const node = await startMock();
    const lookup = fidForName(nodeClient(node.url), "nobody", await fakeFnames({}));
    await expect(lookup).rejects.toThrow(UsageError);
  });

  it("does not leave the node when the fname server is not allowed", async () => {
    const node = await startMock();
    const lookup = fidForName(nodeClient(node.url), "elsewhere", undefined);
    await expect(lookup).rejects.toMatchObject({ hint: "the node does not know it; pass the fid" });
  });
});
