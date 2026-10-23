import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { deriveCustody, validateMnemonic } from "../../src/custody/mnemonic.js";
import { ConfigError } from "../../src/errors.js";
import { TEST_MNEMONIC } from "../helpers.js";

// Vectors from viem@2.57.7 test/src/constants.ts (`accounts[0]`, `accounts[1]`), which
// viem's mnemonicToAccount.test.ts derives from this same phrase with addressIndex 0 and 1.
const VECTORS = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
];

const bytes = (s: string) => new TextEncoder().encode(s);

describe("validateMnemonic", () => {
  it("accepts the BIP-39 reference phrase", () => {
    expect(() => validateMnemonic(TEST_MNEMONIC)).not.toThrow();
  });

  it("rejects a phrase whose checksum word is wrong", () => {
    expect(() => validateMnemonic(TEST_MNEMONIC.replace("junk", "test"))).toThrow(/checksum/);
  });

  it("rejects the wrong number of words", () => {
    expect(() => validateMnemonic("test test test")).toThrow(/12, 15, 18, 21 or 24 words/);
  });

  it("rejects words outside the English list without echoing them", () => {
    const typo = () => validateMnemonic(TEST_MNEMONIC.replace("junk", "jnuk"));
    expect(typo).toThrow(/word 12 is not/);
    expect(typo).not.toThrow(/jnuk/);
  });

  it("raises a config error, which the CLI turns into exit code 5", () => {
    expect(() => validateMnemonic("nope")).toThrow(ConfigError);
  });
});

describe("deriveCustody", () => {
  it.each([0, 1])("derives viem's vector for addressIndex %i", (index) => {
    expect(deriveCustody(bytes(TEST_MNEMONIC), index).address).toBe(
      getAddress(VECTORS[index] ?? ""),
    );
  });

  it("tolerates surrounding whitespace and a trailing newline", () => {
    expect(deriveCustody(bytes(`  ${TEST_MNEMONIC}\n`), 0).address).toBe(
      getAddress(VECTORS[0] ?? ""),
    );
  });

  it("zeroes the mnemonic bytes after use", () => {
    const secret = bytes(TEST_MNEMONIC);
    deriveCustody(secret, 0);
    expect(secret.every((b) => b === 0)).toBe(true);
  });

  it("zeroes the mnemonic bytes when the phrase is invalid", () => {
    const secret = bytes("not a mnemonic");
    expect(() => deriveCustody(secret, 0)).toThrow(ConfigError);
    expect(secret.every((b) => b === 0)).toBe(true);
  });
});
