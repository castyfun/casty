import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CastType,
  encodeGaslessSignedKeyRequestMetadata,
  FARCASTER_EPOCH,
  FarcasterNetwork,
  getDefaultStoreLimit,
  type HubAsyncResult,
  type Message,
  MessageType,
  makeCastAdd,
  makeLinkAdd,
  makeReactionAdd,
  makeUserDataAdd,
  makeVerificationAddEthAddress,
  makeVerificationAddressClaim,
  NobleEd25519Signer,
  Protocol,
  ReactionType,
  StorageUnitType,
  StoreType,
  UserDataType,
  ViemLocalEip712Signer,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  bytesToWireHex,
  messageToWire,
  type WireMessage,
  type WireOnChainEvent,
  type WireSigner,
  type WireSigners,
  type WireStorageLimits,
} from "./wire.js";

/** The only mnemonic allowed in this repository (BIP-39 reference phrase). */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * The fixture world. Every fid is offset by FID_BASE, far above any registered account, so no
 * real person's fid appears in fixtures or tests. ME_FID is "you": custodied by TEST_MNEMONIC
 * address index 0, following every generated author (FIRST_AUTHOR onwards), holding one
 * onchain key from app-beta. app-alpha is custodied by index 1, so a test can request keys as
 * that app. NO_STORAGE_FID (index 2) has no storage.
 */
export const FID_BASE = 2_000_000_000;
export const ME_FID = FID_BASE + 1;
export const FIRST_AUTHOR = ME_FID + 1;
export const APPS = [
  { fid: FID_BASE + 9001, name: "app-alpha" },
  { fid: FID_BASE + 9002, name: "app-beta" },
] as const;
export const NO_STORAGE_FID = FID_BASE + 9100;
export const CHANNEL_URL = "https://example.com/~/channel/casty";
/** 2026-10-01T00:00:00Z in Farcaster seconds; every generated timestamp is at or before it. */
export const FIXTURE_TIME = (Date.UTC(2026, 9, 1) - FARCASTER_EPOCH) / 1000;

export interface Fixtures {
  fids: number[];
  casts: WireMessage[];
  links: WireMessage[];
  reactions: WireMessage[];
  userdata: WireMessage[];
  /** Every other author has verified an Ethereum address, signed for real by a throwaway key. */
  verifications: WireMessage[];
  signers: Record<string, WireSigners>;
  storage: Record<string, WireStorageLimits>;
  onchain: WireOnChainEvent[];
}

const FILES = [
  "fids",
  "casts",
  "links",
  "reactions",
  "userdata",
  "verifications",
  "signers",
  "storage",
  "onchain",
] as const;
const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures");

/** Reads `fixtures/<name>/` or, when `nameOrDir` contains a slash, that directory. */
export function loadFixtures(nameOrDir: string): Fixtures {
  const dir = nameOrDir.includes("/") ? nameOrDir : join(FIXTURE_ROOT, nameOrDir);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, `${file}.json`), "utf8"));
  return Object.fromEntries(FILES.map((file) => [file, read(file)])) as unknown as Fixtures;
}

export function writeFixtures(dir: string, fixtures: Fixtures): void {
  mkdirSync(dir, { recursive: true });
  for (const file of FILES) {
    writeFileSync(join(dir, `${file}.json`), `${JSON.stringify(fixtures[file], null, 2)}\n`);
  }
}

const sha256 = (text: string) => new Uint8Array(createHash("sha256").update(text).digest());

/** Deterministic throwaway ed25519 key of a fixture fid. */
export function fixtureKey(seed: number, fid: number): Uint8Array {
  return sha256(`casty-fixture:${seed}:key:${fid}`);
}

function custodyAddress(seed: number, fid: number): string {
  const index = { [ME_FID]: 0, [APPS[0].fid]: 1, [NO_STORAGE_FID]: 2 }[fid];
  const account =
    index === undefined
      ? privateKeyToAccount(bytesToHex(sha256(`casty-fixture:${seed}:custody:${fid}`)))
      : mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
  return account.address.toLowerCase();
}

export interface GenOptions {
  /** Number of authors (FIRST_AUTHOR onwards) that ME_FID follows. */
  fids: number;
  /** Casts per author. */
  casts: number;
  seed: number;
}

// Made-up cast texts, so a feed read from the fixtures looks like one. Mentions go at byte 0,
// so those texts start with the space that follows the name.
const TEXTS = {
  plain: [
    "gm. Coffee first, then the backlog.",
    "Moved all my notes into one folder. Ten minutes of work I put off for a year.",
    "Reading the Snapchain docs on a train. A good way to spend an hour.",
    "Small wins today: the build is green and the tests are fast.",
    "Is anyone else running a node at home? Curious how the disk holds up.",
    "Long walk, no phone. Recommended.",
    "Shipped the fix and wrote the changelog.\n\nThe bug was a missing await, as usual.",
    "What is a good first project for someone learning TypeScript?",
  ],
  reply: [
    "Agreed, and the second part matters more.",
    "Same here. It took me a weekend to get right.",
    "I would start with something you use every day.",
  ],
  channel: [
    "Weekly thread: what are you building?",
    "Posting from the command line today.",
    "Notes from the reading group are up.",
  ],
  mention: [
    " thanks for the pointer, it worked.",
    " have you tried the --since flag?",
    " the write-up is at the link below.",
  ],
};

const pick = (list: string[], seed: number, fid: number, j: number) =>
  list[(sha256(`casty-fixture:${seed}:text:${fid}:${j}`)[0] ?? 0) % list.length] as string;

const unix = (farcasterSeconds: number) => farcasterSeconds + FARCASTER_EPOCH / 1000;
const NINETY_DAYS = 90 * 86400;

/** Builds the fixture world; same options, same bytes. */
export async function generateFixtures({ fids, casts, seed }: GenOptions): Promise<Fixtures> {
  const authors = Array.from({ length: fids }, (_, i) => FIRST_AUTHOR + i);
  const out: Fixtures = {
    fids: [],
    casts: [],
    links: [],
    reactions: [],
    userdata: [],
    verifications: [],
    signers: {},
    storage: {},
    onchain: [],
  };
  const signer = (fid: number) => new NobleEd25519Signer(fixtureKey(seed, fid));
  const options = (fid: number, timestamp: number) => ({
    fid,
    network: FarcasterNetwork.MAINNET,
    timestamp,
  });
  const push = async (list: WireMessage[], made: HubAsyncResult<Message>) => {
    list.push(messageToWire((await made)._unsafeUnwrap()));
  };

  const accounts = [
    { fid: ME_FID, name: "casty-test", requestFid: APPS[1].fid, onchain: true },
    ...APPS.map((app) => ({ fid: app.fid, name: app.name, requestFid: app.fid, onchain: false })),
    ...authors.map((fid, i) => ({
      fid,
      name: `user-${fid}`,
      requestFid: APPS[i % 2]?.fid ?? APPS[0].fid,
      onchain: i % 3 === 0,
    })),
  ];
  for (const account of accounts) {
    out.fids.push(account.fid);
    out.onchain.push(idRegisterEvent(seed, account.fid));
    await addSigner(out, seed, account);
    const username = { type: UserDataType.USERNAME, value: account.name };
    const at = options(account.fid, FIXTURE_TIME - 86400);
    await push(out.userdata, makeUserDataAdd(username, at, signer(account.fid)));
  }
  out.fids.push(NO_STORAGE_FID);
  out.onchain.push(idRegisterEvent(seed, NO_STORAGE_FID));

  // A verified Ethereum address for every other author: the claim is signed by the address
  // (EIP-712), the message by the author's app key, so validation passes as on a node.
  for (const [i, fid] of authors.entries()) {
    if (i % 2 !== 0) continue;
    const wallet = privateKeyToAccount(bytesToHex(sha256(`casty-fixture:${seed}:wallet:${fid}`)));
    const blockHash = sha256(`casty-fixture:${seed}:vblock:${fid}`);
    const address = hexToBytes(wallet.address);
    const claim = makeVerificationAddressClaim(
      fid,
      address,
      FarcasterNetwork.MAINNET,
      blockHash,
      Protocol.ETHEREUM,
    )._unsafeUnwrap();
    const claimSignature = (
      await new ViemLocalEip712Signer(wallet).signVerificationEthAddressClaim(claim)
    )._unsafeUnwrap();
    const body = {
      address,
      claimSignature,
      blockHash,
      verificationType: 0,
      chainId: 0,
      protocol: Protocol.ETHEREUM,
    };
    await push(
      out.verifications,
      makeVerificationAddEthAddress(body, options(fid, FIXTURE_TIME - 2 * 86400), signer(fid)),
    );
  }

  // Replies answer the previous author's newest cast; the first author answers its own first.
  let previous: { fid: number; hash: Uint8Array } | undefined;
  for (const [i, fid] of authors.entries()) {
    for (let j = 0; j < casts; j++) {
      // Authors with the same i % 3 share timestamps, so feed tie-breaks get exercised. Each
      // author starts at another kind, so the newest casts are of every kind.
      const timestamp = FIXTURE_TIME - (casts - j) * 600 - (i % 3);
      const kind = previous || (i + j) % 4 !== 1 ? (i + j) % 4 : 0;
      const pool = [TEXTS.plain, TEXTS.reply, TEXTS.channel, TEXTS.mention][kind] ?? TEXTS.plain;
      const text = pick(pool, seed, fid, j);
      const body = {
        text,
        type: CastType.CAST,
        embeds: kind === 3 ? [{ url: `https://example.com/${fid}/${j}` }] : [],
        embedsDeprecated: [],
        mentions: kind === 3 ? [ME_FID] : [],
        mentionsPositions: kind === 3 ? [0] : [],
        parentCastId: kind === 1 ? previous : undefined,
        parentUrl: kind === 2 ? CHANNEL_URL : undefined,
      };
      const made = (await makeCastAdd(body, options(fid, timestamp), signer(fid)))._unsafeUnwrap();
      out.casts.push(messageToWire(made));
      if (j === casts - 1 || !previous) previous = { fid, hash: made.hash };
    }
  }

  const followAt = FIXTURE_TIME - 3600;
  for (const [i, fid] of authors.entries()) {
    await push(
      out.links,
      makeLinkAdd({ type: "follow", targetFid: fid }, options(ME_FID, followAt), signer(ME_FID)),
    );
    await push(
      out.links,
      makeLinkAdd({ type: "follow", targetFid: ME_FID }, options(fid, followAt), signer(fid)),
    );
    const next = out.casts.find((c) => c.data.fid === authors[(i + 1) % authors.length]);
    if (!next) continue;
    const target = { fid: next.data.fid, hash: Buffer.from(next.hash.slice(2), "hex") };
    const type = i % 3 === 2 ? ReactionType.RECAST : ReactionType.LIKE;
    await push(
      out.reactions,
      makeReactionAdd({ type, targetCastId: target }, options(fid, followAt), signer(fid)),
    );
  }

  for (const fid of out.fids) out.storage[fid] = storageLimits(out, fid);
  return out;
}

async function addSigner(
  out: Fixtures,
  seed: number,
  account: { fid: number; requestFid: number; onchain: boolean },
): Promise<void> {
  const pubkey = (
    await new NobleEd25519Signer(fixtureKey(seed, account.fid)).getSignerKey()
  )._unsafeUnwrap();
  const key = bytesToWireHex(pubkey);
  const addedAt = unix(FIXTURE_TIME - 30 * 86400);
  let record: WireSigner;
  if (account.onchain) {
    const metadata = encodeGaslessSignedKeyRequestMetadata({
      requestFid: BigInt(account.requestFid),
      requestSigner: custodyAddress(seed, account.requestFid) as `0x${string}`,
      signature: new Uint8Array(65),
      deadline: BigInt(addedAt + 3600),
    })._unsafeUnwrap();
    const event: WireOnChainEvent = {
      ...chainEventBase(seed, account.fid, "EVENT_TYPE_SIGNER", 1),
      signerEventBody: {
        key,
        keyType: 1,
        eventType: "SIGNER_EVENT_TYPE_ADD",
        metadata: Buffer.from(metadata).toString("base64"),
        metadataType: 1,
      },
    };
    out.onchain.push(event);
    record = {
      source: "SIGNER_SOURCE_ONCHAIN",
      key,
      keyType: 1,
      fid: account.fid,
      addedAt,
      scopes: [],
      onChainEvent: event,
    };
  } else {
    const lastUsedAt = unix(FIXTURE_TIME);
    record = {
      source: "SIGNER_SOURCE_OFFCHAIN",
      key,
      keyType: 1,
      fid: account.fid,
      addedAt,
      lastUsedAt,
      ttl: NINETY_DAYS,
      expiresAt: lastUsedAt + NINETY_DAYS,
      scopes: [
        MessageType.CAST_ADD,
        MessageType.CAST_REMOVE,
        MessageType.REACTION_ADD,
        MessageType.REACTION_REMOVE,
        MessageType.LINK_ADD,
        MessageType.LINK_REMOVE,
        MessageType.USER_DATA_ADD,
      ],
      requestFid: account.requestFid,
      nonce: 1,
    };
  }
  out.signers[account.fid] = {
    signers: [record],
    currentUserNonce: account.onchain ? 0 : 1,
    requesterFidNonces: {},
  };
}

function chainEventBase(seed: number, fid: number, type: string, logIndex: number) {
  return {
    type,
    chainId: 10,
    blockNumber: 120_000_000 + (fid - FID_BASE),
    blockHash: bytesToWireHex(sha256(`casty-fixture:${seed}:block:${fid}`)),
    blockTimestamp: unix(FIXTURE_TIME - 60 * 86400),
    transactionHash: bytesToWireHex(sha256(`casty-fixture:${seed}:tx:${fid}:${logIndex}`)),
    logIndex,
    fid,
    txIndex: 0,
  };
}

function idRegisterEvent(seed: number, fid: number): WireOnChainEvent {
  return {
    ...chainEventBase(seed, fid, "EVENT_TYPE_ID_REGISTER", 0),
    idRegisterEventBody: {
      to: custodyAddress(seed, fid),
      eventType: "Register", // as a mainnet node prints it
      from: "0x",
      recoveryAddress: `0x${"00".repeat(20)}`,
    },
  };
}

function storageLimits(out: Fixtures, fid: number): WireStorageLimits {
  const units = fid === NO_STORAGE_FID ? 0 : 1;
  const count = (list: WireMessage[]) => list.filter((m) => m.data.fid === fid).length;
  const store = (storeType: string, name: string, type: StoreType, used: number) => ({
    storeType,
    name,
    limit: units * getDefaultStoreLimit(type, StorageUnitType.UNIT_TYPE_2025),
    used,
    earliestTimestamp: 0,
    earliestHash: [],
  });
  return {
    limits: [
      store("Casts", "CASTS", StoreType.CASTS, count(out.casts)),
      store("Links", "LINKS", StoreType.LINKS, count(out.links)),
      store("Reactions", "REACTIONS", StoreType.REACTIONS, count(out.reactions)),
      store("UserData", "USER_DATA", StoreType.USER_DATA, count(out.userdata)),
      store("Verifications", "VERIFICATIONS", StoreType.VERIFICATIONS, count(out.verifications)),
    ],
    units,
    unit_details: [
      { unitType: "UnitTypeLegacy", unitSize: 0 },
      { unitType: "UnitType2024", unitSize: 0 },
      { unitType: "UnitType2025", unitSize: units },
    ],
  };
}
