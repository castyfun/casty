import { readFileSync } from "node:fs";
import type { NobleEd25519Signer } from "@farcaster/core";
import type { Command } from "commander";
import {
  type Config,
  configDir,
  DEFAULT_NODE_URL,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  readConfig,
} from "../config.js";
import { ConfigError } from "../errors.js";
import { privateKeyBytes, withSigner } from "../keys/signer.js";
import { type KeyRecord, loadKeys } from "../keys/store.js";
import { type NodeClient, nodeClient } from "../node/http.js";
import type { ConfirmOptions } from "../submit/confirm.js";
import { readFirstLine } from "./prompt.js";

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean | undefined };
  /** `columns` and `isTTY` are set when the stream is a terminal; text wraps to it, else to 80. */
  stdout: { write(text: string): unknown; columns?: number; isTTY?: boolean | undefined };
  stderr: { write(text: string): unknown; columns?: number };
  env: NodeJS.ProcessEnv;
  /** Reads a secret without echo. Absent when there is no terminal, e.g. in tests. */
  prompt?: (question: string) => Promise<Uint8Array>;
  /** How long to wait for a submitted message to merge; tests shorten it. */
  confirm?: ConfirmOptions;
  /** Ends a command that keeps running, such as casty web; Ctrl-C does otherwise. */
  until?: Promise<unknown>;
}

interface GlobalOptions {
  node: string;
  json?: boolean;
  config?: string;
  quiet?: boolean;
}

export interface Context {
  io: Io;
  node: NodeClient;
  /** The url `node` talks to. */
  nodeUrl: string;
  json: boolean;
  dir: string;
  confirm: ConfirmOptions;
  /** The command's result: JSON with --json, `text` otherwise. */
  print(data: unknown, text: string): void;
  /** Progress on stderr; silenced by --quiet. */
  note(text: string): void;
}

/** The node named on the command line, else the one casty init remembered, else the tunnel. */
function nodeUrl(command: Command, options: GlobalOptions, dir: string): string {
  let root = command;
  while (root.parent) root = root.parent;
  if (root.getOptionValueSource("node") !== "default") return options.node;
  try {
    return readConfig(dir)?.node ?? options.node;
  } catch {
    // A config that cannot be read is reported by the command that needs it.
    return options.node;
  }
}

/** What casty init records as the node: nothing for the tunnel, which is the default anyway. */
export function nodeToRemember(ctx: Context): string | undefined {
  return ctx.nodeUrl === DEFAULT_NODE_URL ? undefined : ctx.nodeUrl;
}

export function contextFor(command: Command, io: Io): Context {
  const options = command.optsWithGlobals<GlobalOptions>();
  const json = Boolean(options.json);
  const dir = configDir(options.config, io.env);
  const url = nodeUrl(command, options, dir);
  return {
    io,
    node: nodeClient(url),
    nodeUrl: url,
    json,
    dir,
    confirm: io.confirm ?? {},
    print: (data, text) => io.stdout.write(`${json ? JSON.stringify(data, null, 2) : text}\n`),
    note: (text) => {
      if (!options.quiet) io.stderr.write(`${text}\n`);
    },
  };
}

export function requireConfig(ctx: Context): Config {
  const config = readConfig(ctx.dir);
  if (!config) throw new ConfigError(`casty is not set up in ${ctx.dir}`, "run casty init");
  return config;
}

async function ask(ctx: Context, question: string, hint: string): Promise<Uint8Array> {
  if (!ctx.io.prompt) throw new ConfigError("there is no terminal to ask on", hint);
  return ctx.io.prompt(question);
}

/** The key store passphrase, asked twice when a new store is about to be created. */
export async function passphrase(ctx: Context, creating: boolean): Promise<string> {
  const fromEnv = ctx.io.env[PASSPHRASE_ENV];
  if (fromEnv) return fromEnv;
  // A docker secret or a systemd credential: the file holds the passphrase, casty serve starts
  // without a terminal.
  const file = ctx.io.env[PASSPHRASE_FILE_ENV];
  if (file) {
    try {
      // The first line: an editor's trailing newline, or two, is not part of it.
      const text = readFileSync(file, "utf8").split(/\r?\n/)[0];
      if (text) return text;
    } catch {}
    throw new ConfigError(
      `cannot read the key store passphrase from ${file} (${PASSPHRASE_FILE_ENV})`,
      "the file must exist, be readable, and hold the passphrase on its first line",
    );
  }
  const hint = `run casty in a terminal (${PASSPHRASE_ENV} exists for tests only)`;
  // The string cannot be wiped, but the typed bytes can.
  const decode = (bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    bytes.fill(0);
    return text;
  };
  const first = decode(await ask(ctx, "key store passphrase: ", hint));
  if (!first) throw new ConfigError("the passphrase is empty");
  if (creating && decode(await ask(ctx, "same passphrase again: ", hint)) !== first) {
    throw new ConfigError("the two passphrases differ");
  }
  return first;
}

/** Printed before every seed phrase casty reads; the docs and 2-client.sh say the same. */
export const SEED_PHRASE_WARNING = [
  "A seed phrase controls the whole account. Use a test account to try casty, and paste a seed",
  "phrase only into software from developers you trust. Prefer a key authorised by your wallet:",
  'casty init --fid <fid>, then casty web and, under you, "add a key with your wallet".',
].join("\n");

/**
 * Seed phrase bytes from piped stdin or a hidden prompt; a terminal on stdin would echo the
 * phrase, so it gets the hidden prompt too. The caller zeroes the bytes (deriveCustody does).
 */
export function mnemonic(ctx: Context, fromStdin: boolean | undefined): Promise<Uint8Array> {
  ctx.note(SEED_PHRASE_WARNING);
  if (fromStdin && !ctx.io.stdin.isTTY) return readFirstLine(ctx.io.stdin);
  return ask(ctx, "seed phrase (input hidden): ", "pipe it in with --mnemonic-stdin");
}

/**
 * The code that builds and signs messages (it loads @farcaster/core, about 0.3 s), started
 * before the passphrase is asked for, so it loads while it is typed. Await it once signing.
 */
export function signing(): Promise<typeof import("../submit/actions.js")> {
  const actions = import("../submit/actions.js");
  actions.catch(() => {});
  return actions;
}

/**
 * Runs `fn` with the newest stored app key that the node lists for the configured fid, so a
 * key that expired, was revoked elsewhere or never merged is skipped. The private key is
 * zeroed afterwards. `unlocked` is the decrypted store, for a caller that keeps it open.
 */
export async function withAppKey<T>(
  ctx: Context,
  fn: (signer: NobleEd25519Signer, config: Config) => Promise<T>,
  unlocked?: KeyRecord[],
): Promise<T> {
  const config = requireConfig(ctx);
  // Asked first, so the node answers while the passphrase is typed and scrypt runs. A wrong
  // passphrase throws before the answer is awaited; the catch keeps that from going unhandled.
  const listed = ctx.node.signersByFid(config.fid);
  listed.catch(() => {});
  const records = unlocked ?? loadKeys(ctx.dir, await passphrase(ctx, false));
  const { signers } = await listed;
  // A gasless key lapses TTL seconds after its last use (expiresAt, unix seconds); the node may
  // still list it. No expiresAt, or 0, is a key that does not lapse, as casty clients shows it.
  const now = Date.now() / 1000;
  const active = new Set(
    signers.filter((s) => !s.expiresAt || s.expiresAt > now).map((s) => s.key),
  );
  const record = records.findLast((r) => r.fid === config.fid && active.has(`0x${r.pubkey}`));
  if (!record && !records.some((r) => r.fid === config.fid)) {
    throw new ConfigError(
      `no app key for fid ${config.fid} yet`,
      "add one with your wallet in casty web, under you, or run casty init with the seed phrase",
    );
  }
  if (!record) {
    throw new ConfigError(
      `none of the app keys in ${ctx.dir} is registered to fid ${config.fid}`,
      "a key added a moment ago counts once your node has it (casty doctor shows how far behind it is); keys also expire after their TTL without use, or were revoked: add one in casty web, under you, or with casty init",
    );
  }
  return withSigner(privateKeyBytes(record.privkey), (signer) => fn(signer, config));
}
