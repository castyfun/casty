import { ed25519 } from "@farcaster/core";
import { expect, it } from "vitest";
import { generateKey, privateKeyBytes, withSigner } from "../../src/keys/signer.js";
import { fixedPrivateKey } from "../helpers.js";

it("generates a 32-byte ed25519 key pair", async () => {
  const { privkey, pubkey } = await generateKey();
  expect(privkey).toHaveLength(32);
  expect((await ed25519.getPublicKey(privkey))._unsafeUnwrap()).toEqual(pubkey);
});

it("signs with the key and zeroes it afterwards", async () => {
  const privkey = fixedPrivateKey();
  const pubkey = (await ed25519.getPublicKey(privkey))._unsafeUnwrap();
  const hash = new Uint8Array(20).fill(3);
  const signature = await withSigner(privkey, async (s) =>
    (await s.signMessageHash(hash))._unsafeUnwrap(),
  );
  expect((await ed25519.verifyMessageHashSignature(signature, hash, pubkey))._unsafeUnwrap()).toBe(
    true,
  );
  expect(privkey.every((b) => b === 0)).toBe(true);
});

it("zeroes the key even when signing fails", async () => {
  const privkey = fixedPrivateKey();
  await expect(
    withSigner(privkey, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(privkey.every((b) => b === 0)).toBe(true);
});

it("decodes a stored private key into memory of its own, so zeroing it leaves no copy", () => {
  const hex = "ab".repeat(32);
  const bytes = privateKeyBytes(hex);
  expect(Buffer.from(bytes).toString("hex")).toBe(hex);
  // Buffer.from(hex, "hex") would land in Node's shared pool, which the caller cannot zero.
  expect(bytes.byteOffset).toBe(0);
  expect(bytes.buffer.byteLength).toBe(32);
});
