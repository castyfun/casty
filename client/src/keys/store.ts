import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { writeAtomic } from "../config.js";
import { ConfigError } from "../errors.js";

export const KEY_FILE = "keys.enc.json";

/** One app key. `pubkey` and `privkey` are hex without a 0x prefix. */
export interface KeyRecord {
  fid: number;
  pubkey: string;
  privkey: string;
  requestFid: number;
  scopes: number[];
  ttl: number;
  createdAt: string;
  network: string;
  /** The signed KEY_ADD (hex), kept until `casty init` sees the key listed, so it can resend it. */
  keyAdd?: string;
}

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

interface KeyFile {
  v: 1;
  kdf: ScryptCost & { name: "scrypt"; salt: string };
  cipher: "xchacha20poly1305";
  nonce: string;
  ct: string;
}

const DEFAULT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Uint8Array, { N, r, p }: ScryptCost): Uint8Array {
  // scrypt needs 128 * N * r bytes; allow twice that.
  return scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r });
}

/** Encrypts `records` into `dir/keys.enc.json` (mode 0600), replacing the file atomically. */
export function saveKeys(dir: string, records: KeyRecord[], passphrase: string): void {
  writeKeys(dir, records, passphrase, DEFAULT_COST);
}

/**
 * Reads the store again, applies `change` and saves the result, so a key another casty stored
 * since this one loaded it is kept: casty web holds its copy for days, init waits up to 40 s.
 */
// ponytail: no lock; two writers in the same half second (scrypt twice) can still lose one.
// A lock file around this if that is ever seen.
export function updateKeys(
  dir: string,
  passphrase: string,
  change: (records: KeyRecord[]) => KeyRecord[],
): KeyRecord[] {
  const records = change(loadKeys(dir, passphrase));
  saveKeys(dir, records, passphrase);
  return records;
}

/** saveKeys at another scrypt cost, for tests, which need a cheap one; casty never calls it. */
export function writeKeys(
  dir: string,
  records: KeyRecord[],
  passphrase: string,
  cost: ScryptCost,
): void {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = deriveKey(passphrase, salt, cost);
  const plaintext = new TextEncoder().encode(JSON.stringify(records));
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  key.fill(0);
  plaintext.fill(0);

  const file: KeyFile = {
    v: 1,
    kdf: { name: "scrypt", ...cost, salt: salt.toString("hex") },
    cipher: "xchacha20poly1305",
    nonce: nonce.toString("hex"),
    ct: Buffer.from(ct).toString("hex"),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, KEY_FILE);
  writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** Decrypts the key store; an absent file means no keys yet. */
export function loadKeys(dir: string, passphrase: string): KeyRecord[] {
  const path = join(dir, KEY_FILE);
  if (!existsSync(path)) return [];
  const damaged = new ConfigError(
    "cannot decrypt the key store: wrong passphrase or a damaged file",
    `file: ${path}`,
  );

  let file: KeyFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw damaged;
  }
  if (file.v !== 1 || file.cipher !== "xchacha20poly1305" || file.kdf?.name !== "scrypt") {
    throw new ConfigError(`${path} has an unsupported version or format`);
  }

  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, "hex"), file.kdf);
  try {
    const cipher = xchacha20poly1305(key, Buffer.from(file.nonce, "hex"));
    const plaintext = cipher.decrypt(Buffer.from(file.ct, "hex"));
    const records: KeyRecord[] = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    return records;
  } catch {
    throw damaged;
  } finally {
    key.fill(0);
  }
}
