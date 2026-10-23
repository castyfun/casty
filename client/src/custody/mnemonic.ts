import { createHash } from "node:crypto";
import { english, type HDAccount, mnemonicToAccount } from "viem/accounts";
import { ConfigError } from "../errors.js";

const WORD_COUNTS = [12, 15, 18, 21, 24];

/**
 * BIP-39 word count, word list and checksum. Errors name word positions, never the words,
 * because a mistyped word is still most of a secret.
 */
export function validateMnemonic(phrase: string): void {
  const words = phrase.trim().split(/\s+/);
  if (!WORD_COUNTS.includes(words.length)) {
    throw new ConfigError(`a seed phrase has 12, 15, 18, 21 or 24 words, not ${words.length}`);
  }
  const bits = words
    .map((word, i) => {
      const index = english.indexOf(word);
      if (index < 0) throw new ConfigError(`word ${i + 1} is not in the BIP-39 English word list`);
      return index.toString(2).padStart(11, "0");
    })
    .join("");
  const checksumBits = words.length / 3;
  const entropy = Buffer.from(
    (bits.slice(0, -checksumBits).match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)),
  );
  const digest = createHash("sha256").update(entropy).digest();
  const expected = digest.readUInt8(0).toString(2).padStart(8, "0").slice(0, checksumBits);
  if (bits.slice(-checksumBits) !== expected) {
    throw new ConfigError(
      "the seed phrase checksum does not match",
      "check word order and spelling",
    );
  }
}

/**
 * Derives the custody account at `addressIndex` and zeroes `mnemonic`, valid or not.
 * The decoded string cannot be wiped in JavaScript; it goes out of scope right here.
 */
export function deriveCustody(mnemonic: Uint8Array, addressIndex: number): HDAccount {
  try {
    const phrase = new TextDecoder().decode(mnemonic).trim().split(/\s+/).join(" ");
    validateMnemonic(phrase);
    // export declare function mnemonicToAccount(mnemonic: string, { passphrase, ...hdKeyOpts }?: MnemonicToAccountOptions): HDAccount;
    return mnemonicToAccount(phrase, { addressIndex });
  } finally {
    mnemonic.fill(0);
  }
}
