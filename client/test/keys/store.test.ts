import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { type KeyRecord, loadKeys, writeKeys } from "../../src/keys/store.js";
import { tempDir } from "../tmp.js";

// Cheap scrypt cost so the suite stays fast; the file records whatever cost was used.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const RECORD: KeyRecord = {
  fid: 2_000_001_234,
  pubkey: "aa".repeat(32),
  privkey: "bb".repeat(32),
  requestFid: 2_000_001_234,
  scopes: [1, 2],
  ttl: 2592000,
  createdAt: "2026-10-18T12:00:00.000Z",
  network: "FARCASTER_NETWORK_MAINNET",
};

let dir: string;
beforeEach(() => {
  dir = tempDir("casty-store-");
});

it("encrypts with scrypt N=2^17, r=8, p=1, and reads it back", async () => {
  // test/setup.ts lowers the cost for the CLI and web tests; this checks the real one.
  const real =
    await vi.importActual<typeof import("../../src/keys/store.js")>("../../src/keys/store.js");
  real.saveKeys(dir, [RECORD], "pw");
  const { kdf } = JSON.parse(readFileSync(join(dir, "keys.enc.json"), "utf8"));
  expect(kdf).toMatchObject({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
  expect(loadKeys(dir, "pw")).toEqual([RECORD]);
});

it("is written at another cost only by tests: nothing in src calls writeKeys", () => {
  const src = join(import.meta.dirname, "../../src");
  const callers = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    (file) =>
      file.endsWith(".ts") &&
      file !== join("keys", "store.ts") &&
      readFileSync(join(src, file), "utf8").includes("writeKeys"),
  );
  expect(callers).toEqual([]);
});

it("returns no keys when nothing has been stored", () => {
  expect(loadKeys(dir, "pw")).toEqual([]);
});

it("round-trips key records through encryption", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  expect(loadKeys(dir, "pw")).toEqual([RECORD]);
});

it("writes the documented envelope and never the private key in clear", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  const raw = readFileSync(join(dir, "keys.enc.json"), "utf8");
  const file = JSON.parse(raw);
  expect(file).toMatchObject({
    v: 1,
    kdf: { name: "scrypt", ...FAST },
    cipher: "xchacha20poly1305",
  });
  expect(Object.keys(file).sort()).toEqual(["cipher", "ct", "kdf", "nonce", "v"]);
  expect(raw).not.toContain(RECORD.privkey);
});

it("creates the file with mode 0600", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  expect(statSync(join(dir, "keys.enc.json")).mode & 0o777).toBe(0o600);
});

it("fails on the wrong passphrase", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  expect(() => loadKeys(dir, "other")).toThrow(ConfigError);
});

it("fails when the ciphertext was tampered with", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  const path = join(dir, "keys.enc.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  const last = file.ct.slice(-2) === "00" ? "01" : "00";
  file.ct = file.ct.slice(0, -2) + last;
  writeFileSync(path, JSON.stringify(file));
  expect(() => loadKeys(dir, "pw")).toThrow(ConfigError);
});

it("rejects a file with an unknown version", () => {
  writeKeys(dir, [RECORD], "pw", FAST);
  const path = join(dir, "keys.enc.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), v: 2 }));
  expect(() => loadKeys(dir, "pw")).toThrow(/version/);
});
