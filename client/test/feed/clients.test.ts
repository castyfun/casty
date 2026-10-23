import { APPS, FID_BASE, FIRST_AUTHOR, ME_FID } from "@casty/mock-node";
import { describe, expect, it } from "vitest";
import { diskCache } from "../../src/config.js";
import { appLabeller, requestFidOf, usernames } from "../../src/feed/clients.js";
import { nodeClient } from "../../src/node/http.js";
import { startMock } from "../mock.js";

const GASLESS_AUTHOR = FIRST_AUTHOR + 1; // authors with index % 3 !== 0 hold gasless keys

describe("requestFidOf", () => {
  it("reads requestFid straight from a gasless key", async () => {
    const node = await startMock();
    const { signers } = await nodeClient(node.url).signersByFid(GASLESS_AUTHOR);
    expect(signers[0]?.source).toBe("SIGNER_SOURCE_OFFCHAIN");
    expect(await requestFidOf(signers[0] ?? never())).toBe(APPS[1].fid);
  });

  it("decodes requestFid from an onchain key's SignedKeyRequest metadata", async () => {
    const node = await startMock();
    const { signers } = await nodeClient(node.url).signersByFid(ME_FID);
    expect(signers[0]?.source).toBe("SIGNER_SOURCE_ONCHAIN");
    expect(await requestFidOf(signers[0] ?? never())).toBe(APPS[1].fid);
  });
});

describe("appLabeller", () => {
  it("finds the app fid behind each signer, asking for an author's signers once", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    let calls = 0;
    const counted = {
      ...api,
      signersByFid: (fid: number, requesterFids?: number[]) => {
        calls++;
        return api.signersByFid(fid, requesterFids);
      },
    };
    const { signers } = await api.signersByFid(GASLESS_AUTHOR);
    const key = signers[0]?.key ?? never();
    const label = appLabeller(counted, undefined);
    const pairs = Array.from({ length: 5 }, () => ({ fid: GASLESS_AUTHOR, signer: key }));
    const labels = await label(pairs);
    expect(labels.get(`${GASLESS_AUTHOR}:${key}`)).toBe(APPS[1].fid);
    expect(calls).toBe(1);
  });

  it("asks again for an author whose cached keys miss a new one, and remembers the answer", async () => {
    const node = await startMock();
    const api = nodeClient(node.url);
    const { signers } = await api.signersByFid(GASLESS_AUTHOR);
    const key = signers[0]?.key ?? never();
    const cache = diskCache<Record<string, number>>(undefined, "signers", 60_000);
    cache.set(String(GASLESS_AUTHOR), {});
    let calls = 0;
    const counted = {
      ...api,
      signersByFid: (fid: number) => {
        calls++;
        return api.signersByFid(fid);
      },
    };
    const label = appLabeller(counted, cache);
    const labels = await label([{ fid: GASLESS_AUTHOR, signer: key }]);
    expect(labels.get(`${GASLESS_AUTHOR}:${key}`)).toBe(APPS[1].fid);
    await label([{ fid: GASLESS_AUTHOR, signer: key }]);
    expect(calls).toBe(1);
  });

  it("leaves unknown signers unlabelled", async () => {
    const node = await startMock();
    const labels = await appLabeller(
      nodeClient(node.url),
      undefined,
    )([{ fid: FIRST_AUTHOR, signer: `0x${"00".repeat(32)}` }]);
    expect(labels.get(`${FIRST_AUTHOR}:0x${"00".repeat(32)}`)).toBeUndefined();
  });
});

describe("usernames", () => {
  it("resolves usernames and leaves fids without one undefined", async () => {
    const node = await startMock();
    const names = await usernames(nodeClient(node.url), [ME_FID, FID_BASE + 424242], undefined);
    expect(names.get(ME_FID)).toBe("casty-test");
    expect(names.get(FID_BASE + 424242)).toBeUndefined();
  });
});

function never(): never {
  throw new Error("fixture is missing data");
}
