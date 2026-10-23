import { NobleEd25519Signer } from "@farcaster/core";

/** BIP-39 reference phrase; the only mnemonic allowed in this repository. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/** Deterministic ed25519 key for tests. Never used outside test/. */
export function fixedPrivateKey(fill = 7): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export async function fixedSigner(
  fill = 7,
): Promise<{ signer: NobleEd25519Signer; pubkey: Uint8Array }> {
  const signer = new NobleEd25519Signer(fixedPrivateKey(fill));
  const pubkey = (await signer.getSignerKey())._unsafeUnwrap();
  return { signer, pubkey };
}
