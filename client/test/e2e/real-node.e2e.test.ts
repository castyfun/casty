import { describe, expect, it } from "vitest";
import { type NodeMessage, nodeClient } from "../../src/node/http.js";
import { casty, tempConfig } from "../cli/harness.js";

/**
 * Runs only against a real node, e.g. through the SSH tunnel:
 *   CASTY_E2E_NODE_URL=http://127.0.0.1:3381 CASTY_E2E_MNEMONIC="<test account phrase>" \
 *     pnpm --filter @casty/client test test/e2e
 * Use a test account, never a phrase that holds anything you care about: the phrase controls
 * the whole account. The account needs a storage unit. It publishes one cast and deletes it again, and revokes the
 * app key it added.
 * CASTY_E2E_READ_FID, an account that has been mentioned and replied to, adds read-only checks of
 * the node's answers the client relies on.
 */
const url = process.env.CASTY_E2E_NODE_URL;
const mnemonic = process.env.CASTY_E2E_MNEMONIC;
const readFid = Number(process.env.CASTY_E2E_READ_FID) || undefined;

const newestFirst = (casts: NodeMessage[]) =>
  casts.every(
    (c, i) => i === 0 || (casts[i - 1] as NodeMessage).data.timestamp >= c.data.timestamp,
  );

describe.skipIf(!url || !readFid)("what a real node answers", () => {
  const node = () => nodeClient(url as string);
  const fid = readFid as number;

  it("pages mentions newest first with reverse, as mentions and the unseen count assume", async () => {
    const { items } = await node().castsByMention(fid, { reverse: true, pageSize: 100 });
    expect(items.length).toBeGreaterThan(1);
    expect(newestFirst(items)).toBe(true);
  });

  it("pages replies newest first with reverse", async () => {
    // Replies to the account's own casts, as the mentions list reads them.
    const own = await node().castsByFid(fid, { reverse: true, pageSize: 25 });
    for (const cast of own.items) {
      const replies = await node().castsByParent(
        { fid, hash: cast.hash },
        { reverse: true, pageSize: 100 },
      );
      if (replies.items.length < 2) continue;
      expect(newestFirst(replies.items)).toBe(true);
      return;
    }
    throw new Error(`none of fid ${fid}'s newest casts has two replies; pick another account`);
  });

  it("answers a cast, a reaction, a follow and a name that are not there as not found", async () => {
    const hash = `0x${"00".repeat(20)}` as const;
    expect(await node().castById(fid, hash)).toBeUndefined();
    expect(await node().reactionById(fid, "Like", { fid, hash })).toBeUndefined();
    // Not fid to itself: fid 3 follows itself on mainnet.
    expect(await node().linkById(fid, 999_999_999)).toBeUndefined();
    expect(await node().userNameProofByName("casty-e2e-no-such-name")).toBeUndefined();
  });

  it("lists signers with 0x keys and scopes as message type names, and storage as units and named limits", async () => {
    const { signers } = await node().signersByFid(fid);
    expect(signers.length).toBeGreaterThan(0);
    for (const signer of signers) {
      expect(signer.key).toMatch(/^0x[0-9a-f]{64}$/);
      // Snapchain 0.14 prints scopes as names and leaves them out on an onchain key.
      expect((signer.scopes ?? []).every((s) => /^MESSAGE_TYPE_[A-Z_]+$/.test(String(s)))).toBe(
        true,
      );
    }
    const storage = await node().storageLimitsByFid(fid);
    expect(typeof storage.units).toBe("number");
    expect(
      storage.limits.every((l) => typeof l.name === "string" && typeof l.used === "number"),
    ).toBe(true);
  });
});

describe.skipIf(!url || !mnemonic)("against a real node", () => {
  it("init, cast, read it back, delete it", { timeout: 180_000 }, async () => {
    const env = { CASTY_PASSPHRASE: "e2e" };
    const args = ["--json", "--node", url as string, "--config", tempConfig()];

    const init = await casty(["init", "--mnemonic-stdin", ...args], {
      stdin: `${mnemonic}\n`,
      env,
    });
    expect(init.code, init.stderr).toBe(0);

    try {
      const cast = await casty(["cast", `casty e2e ${new Date().toISOString()}`, ...args], { env });
      expect(cast.code, cast.stderr).toBe(0);
      const { fid, hash } = JSON.parse(cast.stdout);
      expect(await nodeClient(url as string).castById(fid, hash)).toBeDefined();

      const deleted = await casty(["delete", hash, ...args], { env });
      expect(deleted.code, deleted.stderr).toBe(0);
      expect(await nodeClient(url as string).castById(fid, hash)).toBeUndefined();
    } finally {
      // Each run adds an app key; it removes it again, so the test account does not collect them.
      const revoked = await casty(["key", "revoke", "--self", ...args], { env });
      expect(revoked.code, revoked.stderr).toBe(0);
    }
  });
});
