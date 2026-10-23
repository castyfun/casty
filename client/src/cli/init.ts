import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { DEFAULT_SCOPE_NAMES, readConfig, writeConfig } from "../config.js";
import { fidForAddress } from "../custody/fid.js";
import { ConfigError, UsageError } from "../errors.js";
import { generateKey } from "../keys/signer.js";
import { KEY_FILE, type KeyRecord, loadKeys, updateKeys } from "../keys/store.js";
import { NodeError, NonceError, NotMergedError } from "../node/errors.js";
import { parseScopes, scopeGroups, scopeNames } from "../protocol/scopes.js";
import { parseDuration } from "../protocol/time.js";
import { type Context, contextFor, type Io, mnemonic, passphrase } from "./context.js";
import { aboveZero, shortKey, table, wholeNumber } from "./format.js";

interface InitOptions {
  mnemonicStdin?: boolean;
  fid?: number;
  addressIndex: number;
  scopes: string;
  ttl: string;
  appFid?: number;
  appAddressIndex?: number;
  opRpc?: string;
}

export function registerInit(program: Command, io: Io): void {
  program
    .command("init")
    .description(
      "add a gasless app key for your fid: with --fid and your wallet in casty web, or from your seed phrase",
    )
    .option(
      "--fid <fid>",
      "set up for this fid with no seed phrase and no key: casty web then adds a key with your wallet",
      aboveZero,
    )
    .option("--mnemonic-stdin", "read the seed phrase from stdin instead of a hidden prompt")
    .option("--address-index <n>", "custody account index in the seed phrase", wholeNumber, 0)
    .option(
      "--scopes <list>",
      "what the key may sign: cast,reaction,link,user-data",
      DEFAULT_SCOPE_NAMES,
    )
    .option("--ttl <duration>", "key lifetime, renewed by every use, at most 90d", "30d")
    .option(
      "--app-fid <fid>",
      "fid of the app requesting the key (default: your own fid)",
      aboveZero,
    )
    .option(
      "--app-address-index <n>",
      "custody account index of --app-fid in the same seed phrase",
      wholeNumber,
    )
    .option(
      "--op-rpc <url>",
      "OP Mainnet RPC, only needed when the node cannot map your address to a fid",
    )
    .action(async (options: InitOptions, command: Command) =>
      init(contextFor(command, io), options),
    );
}

/** The key and signing code, loaded when init runs rather than whenever casty starts. */
const signing = async () => {
  const [hub, keyadd, custody, confirm] = await Promise.all([
    import("@farcaster/core"),
    import("../protocol/keyadd.js"),
    import("../custody/mnemonic.js"),
    import("../submit/confirm.js"),
  ]);
  return {
    hub,
    keyadd,
    deriveCustody: custody.deriveCustody,
    submitAndConfirm: confirm.submitAndConfirm,
  };
};

async function init(ctx: Context, options: InitOptions): Promise<void> {
  if (options.fid !== undefined) return initForFid(ctx, options.fid);
  const { hub, keyadd, deriveCustody, submitAndConfirm } = await signing();
  const { MAX_KEY_TTL_SECONDS, Message, NobleEd25519Signer, ViemLocalEip712Signer } = hub;
  const { authDeadline, buildKeyAdd } = keyadd;
  const scopes = parseScopes(options.scopes);
  const ttl = parseDuration(options.ttl);
  if (ttl < 1 || ttl > MAX_KEY_TTL_SECONDS) {
    throw new UsageError("--ttl must be more than nothing and at most 90d", "for example 30d");
  }
  if (options.appFid !== undefined && options.appAddressIndex === undefined) {
    throw new UsageError(
      "--app-fid needs --app-address-index",
      "the app's custody key signs the key request",
    );
  }

  // The passphrase comes first, so a typo fails before anything is sent to the node.
  const pass = await passphrase(ctx, !existsSync(join(ctx.dir, KEY_FILE)));
  const existing = loadKeys(ctx.dir, pass);
  const previous = readConfig(ctx.dir);
  // A saved key add the node refused, dropped from the store and the config with the next save.
  let dropped: string | undefined;
  // Only a saved request for the same key is resent; other flags ask for a new key.
  const pending = existing.findLast(
    (r) =>
      r.keyAdd !== undefined &&
      r.fid === previous?.fid &&
      sameRequest(r, scopes, ttl, options.appFid ?? r.fid),
  );
  if (previous && pending?.keyAdd) {
    if (await resend(ctx, pending.fid, pending.pubkey, pending.keyAdd)) {
      const { keyAdd, ...settled } = pending;
      updateKeys(ctx.dir, pass, (records) =>
        records.map((r) => (r.pubkey === pending.pubkey ? settled : r)),
      );
      return await report(ctx, settled, previous.custodyAddress);
    }
    dropped = pending.pubkey;
  }

  const seed = await mnemonic(ctx, options.mnemonicStdin);
  const appSeed = seed.slice();
  let custody: ReturnType<typeof deriveCustody>;
  let app: ReturnType<typeof deriveCustody> | undefined;
  try {
    custody = deriveCustody(seed, options.addressIndex);
    if (options.appAddressIndex !== undefined)
      app = deriveCustody(appSeed, options.appAddressIndex);
  } finally {
    appSeed.fill(0);
  }

  const fid = await fidForAddress(ctx.node, custody.address, options.opRpc);
  ctx.note(`custody address ${custody.address} holds fid ${fid}`);
  const storage = await ctx.node.storageLimitsByFid(fid);
  if (storage.units < 1) {
    throw new ConfigError(
      `fid ${fid} has no storage units, so the network will not accept its messages`,
      "rent a storage unit first",
    );
  }

  const key = await generateKey();
  const pubkey = `0x${Buffer.from(key.pubkey).toString("hex")}`;
  const requestFid = options.appFid ?? fid;
  const record = {
    fid,
    pubkey: pubkey.slice(2),
    privkey: Buffer.from(key.privkey).toString("hex"),
    requestFid,
    scopes,
    ttl,
    createdAt: new Date().toISOString(),
    network: "FARCASTER_NETWORK_MAINNET",
  };
  // The new key's record, or none once the node refused it, over what the store and the config
  // hold now: another casty may have written either since they were read above.
  const remember = (stored?: KeyRecord) => {
    const others = (k: string) => k !== record.pubkey && k !== dropped;
    updateKeys(ctx.dir, pass, (records) => [
      ...records.filter((r) => others(r.pubkey)),
      ...(stored ? [stored] : []),
    ]);
    const current = readConfig(ctx.dir);
    const known = (current?.fid === fid ? current.keys : []).filter((k) => others(k.slice(2)));
    writeConfig(ctx.dir, {
      fid,
      custodyAddress: custody.address,
      keys: stored ? [...known, pubkey] : known,
    });
  };
  try {
    const addKey = async () => {
      const { currentUserNonce } = await ctx.node.signersByFid(fid);
      const input = {
        fid,
        key: key.pubkey,
        scopes,
        ttl,
        currentUserNonce,
        deadline: authDeadline(),
        requestFid,
      };
      const appSigner = app && new ViemLocalEip712Signer(app);
      const message = await buildKeyAdd(
        input,
        new ViemLocalEip712Signer(custody),
        new NobleEd25519Signer(key.privkey),
        appSigner,
      );
      // Stored before it is sent: if the wait is cut short or times out, a key that merges
      // later is still usable, and casty init sends the same bytes again.
      const keyAdd = Buffer.from(Message.encode(message).finish()).toString("hex");
      remember({ ...record, keyAdd });
      await submitAndConfirm(ctx.node, message, registered(ctx, fid, pubkey), ctx.confirm);
    };
    ctx.note("adding a gasless app key (no transaction, no gas)");
    await addKey().catch(async (error) => {
      if (!(error instanceof NonceError)) throw error;
      ctx.note("another key change landed first; retrying with a fresh nonce");
      await addKey();
    });
    remember(record);
  } catch (error) {
    if (error instanceof NotMergedError) throw kept(error);
    // Only a node that refused the key for good means it will never be listed; anything else
    // (a busy node, a lost connection) keeps it and its signed KEY_ADD for the next run.
    if (refused(error)) remember();
    throw error;
  } finally {
    key.privkey.fill(0);
  }

  await report(ctx, record, custody.address);
}

/**
 * The config for a fid whose custody stays in a wallet: the address comes from the node's
 * id-registry events, no key is made, and the page adds one with the wallet's signatures.
 */
async function initForFid(ctx: Context, fid: number): Promise<void> {
  const events = await ctx.node.idRegisterEventsByFid(fid);
  // A recovery change comes after the Register in the list, with "to": "0x" (seen on mainnet).
  const listed = events.findLast((e) =>
    ["Register", "Transfer"].includes(e.idRegisterEventBody?.eventType ?? ""),
  )?.idRegisterEventBody?.to;
  // Checksummed, as the seed-phrase path records it and as a wallet shows it.
  const custody = listed && (await import("viem")).getAddress(listed);
  if (!custody) {
    throw new ConfigError(
      `the node knows no custody address for fid ${fid}`,
      "check the fid; if your node is still syncing, wait for it",
    );
  }
  const previous = readConfig(ctx.dir);
  const keys = previous?.fid === fid ? previous.keys : [];
  const config = { fid, custodyAddress: custody, keys };
  writeConfig(ctx.dir, config);
  ctx.print(
    config,
    table([
      ["fid", String(fid)],
      ["custody", custody],
      ["app key", keys.length ? `${keys.length} kept` : "none yet"],
    ]),
  );
  ctx.note(
    "next: casty web, then under you add an app key with your wallet; or casty init with the seed phrase",
  );
}

/** The relay hint says a rerun sends a new message; for init it resends the same one. */
const kept = (error: NotMergedError) =>
  new NotMergedError(error.message, {
    hint:
      "the key is kept: casty uses it once the node lists it, and casty init run again " +
      "resends the same key add, with no seed phrase",
  });

const sameRequest = (r: KeyRecord, scopes: number[], ttl: number, requestFid: number) =>
  r.ttl === ttl &&
  r.requestFid === requestFid &&
  r.scopes.toSorted().join() === scopes.toSorted().join();

/** A 4xx other than 429: the node will never take these bytes, now or later. */
const refused = (error: unknown): error is NodeError =>
  error instanceof NodeError &&
  !(error instanceof NotMergedError) &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429;

const registered = (ctx: Context, fid: number, pubkey: string) => async () =>
  (await ctx.node.signersByFid(fid)).signers.some((s) => s.key === pubkey);

/**
 * Sends a stored KEY_ADD again, byte for byte, so a rerun after a lost or slow confirmation
 * needs no seed phrase and never authorizes a second key while the first may still merge.
 * True once the node lists the key, false when the node refuses the message for good; a
 * timeout or a node that fails for a while keeps the saved message for the next run.
 */
async function resend(ctx: Context, fid: number, pubkey: string, keyAdd: string) {
  const isListed = registered(ctx, fid, `0x${pubkey}`);
  if (await isListed()) return true;
  ctx.note(`sending the saved key add for ${shortKey(`0x${pubkey}`)} again; no seed phrase needed`);
  const { hub, submitAndConfirm } = await signing();
  try {
    const message = hub.Message.decode(Buffer.from(keyAdd, "hex"));
    await submitAndConfirm(ctx.node, message, isListed, ctx.confirm);
    return true;
  } catch (error) {
    // The first copy may have merged just before this one was sent; the node refuses it then.
    if (await isListed()) return true;
    if (error instanceof NotMergedError) throw kept(error);
    if (!refused(error)) throw error;
    ctx.note(`the node refused the saved key add (${error.message}); adding a new key`);
    return false;
  }
}

async function report(ctx: Context, record: KeyRecord, address: string): Promise<void> {
  const key = `0x${record.pubkey}`;
  const expiresAt = new Date(Date.now() + record.ttl * 1000).toISOString();
  const result = {
    fid: record.fid,
    address,
    key,
    requestFid: record.requestFid,
    scopes: scopeNames(record.scopes),
    ttl: record.ttl,
    expiresAt,
  };
  ctx.print(
    result,
    table([
      ["fid", String(record.fid)],
      ["custody", address],
      ["app key", key],
      ["scopes", scopeGroups(record.scopes).join(", ")],
      ["expires", `${expiresAt.slice(0, 10)}, after ${span(record.ttl)} without use`],
    ]),
  );
  ctx.note('next: casty feed, then casty cast "hello from my own node"');
}

const span = (seconds: number) => {
  const [n, unit] =
    seconds % 86_400 === 0 ? [seconds / 86_400, "day"] : [Math.ceil(seconds / 3600), "hour"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};
