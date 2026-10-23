import { ME_FID, TEST_MNEMONIC } from "@casty/mock-node";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { readConfig } from "../../src/config.js";
import { loadKeys } from "../../src/keys/store.js";
import { setupWeb as setup } from "./setup.js";
import { signAsWallet, type TypedData, wallet } from "./wallet.js";

describe("adding an app key with a wallet", () => {
  it("takes the custody's two signatures, the node lists the key, and the page writes with it", async () => {
    const { api, node, dir } = await setup();
    const start = await api("/api/key/start", {});
    expect(start.status).toBe(200);
    expect(start.body.key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(start.body.custody.toLowerCase()).toBe(wallet.address.toLowerCase());
    const { request, add } = start.body.typedData as { request: TypedData; add: TypedData };
    expect(add.domain).toEqual({ name: "Farcaster KeyAdd", version: "1", chainId: 1 });
    expect(add.primaryType).toBe("KeyAdd");
    expect(add.message).toMatchObject({ fid: String(ME_FID), key: start.body.key, keyType: 1 });
    expect(request.primaryType).toBe("SignedKeyRequest");
    expect(request.message).toMatchObject({ requestFid: String(ME_FID), key: start.body.key });
    expect(add.types.EIP712Domain).toBeDefined();
    const signatures = { request: await signAsWallet(request), add: await signAsWallet(add) };
    const finish = await api("/api/key/finish", { id: start.body.id, signatures });
    expect(finish.status).toBe(200);
    expect(finish.body.key).toBe(start.body.key);
    const listed = node.state.signers.get(ME_FID)?.signers.find((s) => s.key === start.body.key);
    expect(listed).toMatchObject({ requestFid: ME_FID, source: "SIGNER_SOURCE_OFFCHAIN" });
    const records = loadKeys(dir, "x");
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ fid: ME_FID, pubkey: start.body.key.slice(2) });
    expect(records[1]?.keyAdd).toBeUndefined();
    expect(readConfig(dir)?.keys).toContain(start.body.key);
    // With the first key gone from the node, the page writes with the new one.
    const mine = node.state.signers.get(ME_FID);
    if (mine) mine.signers = mine.signers.filter((s) => s.key === start.body.key || !s.ttl);
    const cast = await api("/api/cast", { text: "signed by the key the wallet approved" });
    expect(cast.status).toBe(200);
    expect(node.state.casts.find((c) => c.hash === cast.body.hash)?.signer).toBe(start.body.key);
  });

  it("refuses signatures from another account, naming the custody address, and stores nothing", async () => {
    const { api, node, dir } = await setup();
    const start = await api("/api/key/start", {});
    const other = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
    const signatures = {
      request: await signAsWallet(start.body.typedData.request, other),
      add: await signAsWallet(start.body.typedData.add, other),
    };
    const finish = await api("/api/key/finish", { id: start.body.id, signatures });
    expect(finish.status).toBe(400);
    expect(finish.body.error).toContain(wallet.address);
    expect(node.state.signers.get(ME_FID)?.signers.some((s) => s.key === start.body.key)).toBe(
      false,
    );
    expect(loadKeys(dir, "x")).toHaveLength(1);
  });

  it("refuses a request it did not start, or one finished already", async () => {
    const { api } = await setup();
    const sig = `0x${"ab".repeat(65)}`;
    const nope = await api("/api/key/finish", {
      id: "nope",
      signatures: { request: sig, add: sig },
    });
    expect(nope.status).toBe(404);
    const start = await api("/api/key/start", {});
    const signatures = {
      request: await signAsWallet(start.body.typedData.request),
      add: await signAsWallet(start.body.typedData.add),
    };
    expect((await api("/api/key/finish", { id: start.body.id, signatures })).status).toBe(200);
    expect((await api("/api/key/finish", { id: start.body.id, signatures })).status).toBe(404);
  });

  it("is offered only while the key store is open, which a read-only page has not", async () => {
    const { api } = await setup();
    expect((await api("/api/session")).body.canAddKey).toBe(true);
    const { api: readOnly } = await setup({ write: false });
    expect((await readOnly("/api/session")).body.canAddKey).toBe(false);
    expect((await readOnly("/api/key/start", {})).status).toBe(403);
  });
});
