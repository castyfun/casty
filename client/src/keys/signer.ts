import type { NobleEd25519Signer } from "@farcaster/core";

// @farcaster/core is loaded on first use, not at startup: most commands never sign anything.
const signerClass = async () => (await import("@farcaster/core")).NobleEd25519Signer;

export interface KeyPair {
  privkey: Uint8Array;
  pubkey: Uint8Array;
}

/** A fresh ed25519 app key. Any 32 random bytes are a valid ed25519 private key. */
export async function generateKey(): Promise<KeyPair> {
  const privkey = crypto.getRandomValues(new Uint8Array(32));
  const Signer = await signerClass();
  // getSignerKey(): HubAsyncResult<Uint8Array>;
  const pubkey = (await new Signer(privkey).getSignerKey())._unsafeUnwrap();
  return { privkey, pubkey };
}

/**
 * A stored private key (hex) as bytes in memory of their own. Buffer.from(hex, "hex") would put
 * them in Node's shared pool, where zeroing the copy handed to the signer leaves the original.
 */
export function privateKeyBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  Buffer.from(bytes.buffer).write(hex, "hex");
  return bytes;
}

/** Runs `fn` with a signer over `privkey`, then zeroes `privkey`, which the signer shares. */
export async function withSigner<T>(
  privkey: Uint8Array,
  fn: (signer: NobleEd25519Signer) => Promise<T>,
): Promise<T> {
  try {
    const Signer = await signerClass();
    // constructor(privateKey: Uint8Array);
    return await fn(new Signer(privkey));
  } finally {
    privkey.fill(0);
  }
}
