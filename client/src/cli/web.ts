import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { renderUnicodeCompact } from "uqr";
import { FNAME_SERVER, readConfig, writeConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { KEY_FILE, type KeyRecord, loadKeys, updateKeys } from "../keys/store.js";
import { API_LIMIT_NOTE } from "../web/limits.js";
import {
  type Context,
  contextFor,
  type Io,
  passphrase,
  requireConfig,
  withAppKey,
} from "./context.js";

export interface WebFlags {
  listen: string;
  newToken?: boolean;
  readOnly?: boolean;
  allowFnameServer: boolean;
  /** casty serve: the domain the page is reached at, through a proxy that ends HTTPS. */
  publicHost?: string;
  /** casty serve: the feed from an index, push for mentions, a request limit. */
  serve?: boolean;
}

export const WEB_LISTEN = "127.0.0.1:3390";

export function parseListen(text: string): { host: string; port: number } {
  const match = /^(\[[0-9a-fA-F:]+\]|[^:[\]]+):(\d{1,5})$/.exec(text);
  if (!match || Number(match[2]) > 65535) {
    throw new UsageError(`--listen ${text} is not host:port`, `for example ${WEB_LISTEN}`);
  }
  return { host: (match[1] as string).replace(/^\[(.*)\]$/, "$1"), port: Number(match[2]) };
}

const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || host.startsWith("127.");
const isAny = (host: string) => host === "0.0.0.0" || host === "::";

/** Where a browser can open the page: this machine's network addresses when listening on all. */
function origins(url: string, host: string): string[] {
  if (!isAny(host)) return [url];
  const port = new URL(url).port;
  const lan = Object.values(networkInterfaces())
    .flat()
    .flatMap((a) =>
      a && a.family === "IPv4" && !a.internal ? [`http://${a.address}:${port}`] : [],
    );
  return lan.length > 0 ? lan : [`http://127.0.0.1:${port}`];
}

function listenError(listen: string, error: NodeJS.ErrnoException): Error {
  if (error.code === "EADDRINUSE") {
    return new UsageError(
      `${listen} is in use`,
      "is casty web running already? Otherwise pass --listen with another port",
    );
  }
  if (["EADDRNOTAVAIL", "ENOTFOUND", "EAI_AGAIN", "EACCES"].includes(error.code ?? "")) {
    return new UsageError(
      `cannot listen on ${listen} (${error.code})`,
      `name an address of this machine, such as ${WEB_LISTEN} or 0.0.0.0:3390`,
    );
  }
  return error;
}

const interrupted = () =>
  new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

export function registerWeb(program: Command, io: Io): void {
  program
    .command("web")
    .description("the feed, threads and a compose box in a browser, on this machine or a phone")
    .option(
      "--listen <host:port>",
      "where to serve; 0.0.0.0:3390 lets a phone on the same network in",
      WEB_LISTEN,
    )
    .option("--new-token", "pair again; links printed before stop working")
    .option("--read-only", "do not unlock the app key; the page reads but cannot write")
    .option(
      "--no-allow-fname-server",
      "look @names up with your node only; by default names it does not know are looked up on fnames.farcaster.xyz (public, no key)",
    )
    .action((flags: WebFlags, command: Command) => serveWeb(flags, command, io));
}

/**
 * Runs the page until Ctrl-C (or io.until): `casty web` on this machine, or, with a public
 * host, `casty serve` on the node's host behind a proxy that ends HTTPS, where the links carry
 * that host and the page sends HSTS and limits requests.
 */
export async function serveWeb(flags: WebFlags, command: Command, io: Io): Promise<void> {
  const ctx = contextFor(command, io);
  const name = flags.serve ? "casty serve" : "casty web";
  const listen = parseListen(flags.listen);
  const config = requireConfig(ctx);
  const { chooseToken, saveToken, startWeb } = await import("../web/server.js");
  // A store that does not exist yet (casty init --fid, no key) is made with a passphrase asked
  // twice, as casty init asks; the passphrase is kept so a key added from the page can be stored.
  const pass = flags.readOnly
    ? undefined
    : await passphrase(ctx, !existsSync(join(ctx.dir, KEY_FILE)));
  const records = pass === undefined ? undefined : loadKeys(ctx.dir, pass);
  const token = chooseToken(ctx.dir, Boolean(flags.newToken));
  const addKey =
    records && pass !== undefined
      ? (record: KeyRecord) => {
          // Over what the store and the config hold now: a terminal may have added or revoked a
          // key since this casty web started.
          const stored = updateKeys(ctx.dir, pass, (now) => [
            ...now.filter((r) => r.pubkey !== record.pubkey),
            record,
          ]);
          records.splice(0, records.length, ...stored);
          const current = readConfig(ctx.dir) ?? config;
          const keys = current.keys.filter((k) => k !== `0x${record.pubkey}`);
          config.keys.splice(0, config.keys.length, ...keys, `0x${record.pubkey}`);
          writeConfig(ctx.dir, { ...current, keys: config.keys });
        }
      : undefined;
  // casty serve keeps the feed in an index next to the config, read from the node's events.
  const started = flags.serve ? await startIndex(ctx, config.fid) : undefined;
  const local = started?.local;
  const web = await startWeb(
    {
      node: ctx.node,
      dir: ctx.dir,
      config,
      fnameServer: flags.allowFnameServer ? FNAME_SERVER : undefined,
      confirm: ctx.confirm,
      token,
      local,
      push: started?.push,
      addKey,
      ...(records ? { sign: (fn) => withAppKey(ctx, (signer) => fn(signer), records) } : {}),
    },
    { ...listen, publicHost: flags.publicHost, limit: flags.serve },
  ).catch((error: NodeJS.ErrnoException) => {
    local?.close();
    throw listenError(flags.listen, error);
  });
  // Only now: a --new-token run that could not start leaves the running page paired.
  saveToken(ctx.dir, token);

  const links = flags.publicHost
    ? [`https://${flags.publicHost}/#token=${token}`]
    : origins(web.url, listen.host).map((origin) => `${origin}/#token=${token}`);
  const remote = Boolean(flags.publicHost) || !isLoopback(listen.host);
  const qr = remote ? `\n${renderUnicodeCompact(links[0] as string, { border: 2 })}` : "";
  ctx.print(
    { url: web.url, links },
    `${name} on ${web.url}\nopen to pair a browser: ${links.join("\n  ")}${qr}`,
  );
  if (flags.publicHost) {
    ctx.note(
      `reached as https://${flags.publicHost} through the proxy in front; requests from one address are limited to ${API_LIMIT_NOTE}`,
    );
  } else if (flags.serve) {
    ctx.note(`requests from one address are limited to ${API_LIMIT_NOTE}`);
  }
  if (!flags.publicHost && remote) {
    ctx.note(
      "this is plain HTTP: anyone who can watch this network can take the token and write as " +
        "you while casty web runs. Use a network you trust, or a VPN such as WireGuard.",
    );
  }
  ctx.note(
    records
      ? "Ctrl-C stops it; until then the app key stays unlocked in memory"
      : "read-only: the page cannot write; Ctrl-C stops it",
  );
  await (io.until ?? interrupted());
  const writes = web.pending();
  if (writes > 0) {
    ctx.note(`waiting for ${writes} write(s) to be confirmed; Ctrl-C again stops now`);
    // A second Ctrl-C leaves at once; the node may still relay what it accepted.
    if (!io.until) interrupted().then(() => process.exit(130));
  }
  await web.close();
  local?.close();
  local?.index.close();
}

const INDEX_FILE = "index.sqlite";

/**
 * The index of the feed in the config directory, filled from the node from here on, and the
 * push that tells a phone about a mention or a reply the events bring.
 */
async function startIndex(ctx: Context, fid: number) {
  const { openIndex } = await import("../local/store.js");
  const { startIndexer } = await import("../local/indexer.js");
  const { feedCaches } = await import("../feed/feed.js");
  const { mentionNotifier, openPush } = await import("../web/push.js");
  const path = join(ctx.dir, INDEX_FILE);
  ctx.note(`the feed is indexed into ${path}, from the node's events`);
  const push = openPush(ctx.dir, ctx.note);
  const local = startIndexer(ctx.node, openIndex(path), {
    fid,
    log: ctx.note,
    onNotable: mentionNotifier(ctx.node, feedCaches(ctx.dir).names, push, ctx.note),
  });
  return { local, push };
}
