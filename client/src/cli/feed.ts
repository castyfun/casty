import type { Command } from "commander";
import { FNAME_SERVER, namesCache, readConfig } from "../config.js";
import { fidForName } from "../custody/fid.js";
import { loadFeed } from "../feed/feed.js";
import { renderFeed } from "../feed/render.js";
import { farcasterNow, parseDuration } from "../protocol/time.js";
import { type Context, contextFor, type Io, requireConfig } from "./context.js";
import { aboveZero, accountList, collect, feedStyle } from "./format.js";
import { rememberFeed, resolveChannel } from "./refs.js";

interface FeedFlags {
  limit: number;
  replies: boolean;
  since?: string;
  channel?: string;
  onlyApp?: string[];
  excludeApp?: string[];
  fids?: (number | string)[];
  refresh?: boolean;
}

/** --fids as fids: names are looked up as casty follow looks them up. */
function fidsOf(ctx: Context, accounts: (number | string)[]): Promise<number[]> {
  const names = namesCache(ctx.dir);
  return Promise.all(
    accounts.map((a) => (typeof a === "number" ? a : fidForName(ctx.node, a, FNAME_SERVER, names))),
  );
}

export function registerFeed(program: Command, io: Io): void {
  program
    .command("feed")
    .description("newest casts from you and the accounts you follow, read from your node")
    .option("--limit <n>", "how many casts", aboveZero, 50)
    .option("--no-replies", "leave out replies")
    .option("--since <duration>", "only casts newer than this, e.g. 24h")
    .option(
      "--channel <channel>",
      "only casts in this channel: its parent url, or /name once shown",
    )
    .option(
      "--only-app <name|fid>",
      "only casts signed by keys this app requested (repeatable)",
      collect,
    )
    .option(
      "--exclude-app <name|fid>",
      "leave out casts signed by keys this app requested (repeatable)",
      collect,
    )
    .option(
      "--fids <list>",
      "read these accounts instead of your follows: fids or @names, e.g. 2,@alice",
      accountList,
    )
    .option("--refresh", "ignore the 10-minute follow list cache")
    .action(async (flags: FeedFlags, command: Command) => {
      const ctx = contextFor(command, io);
      const config = flags.fids ? readConfig(ctx.dir) : requireConfig(ctx);
      const now = farcasterNow();
      const items = await loadFeed(ctx.node, {
        fid: config?.fid,
        fids: flags.fids && (await fidsOf(ctx, flags.fids)),
        limit: flags.limit,
        replies: flags.replies,
        since: flags.since === undefined ? undefined : now - parseDuration(flags.since),
        channel: flags.channel === undefined ? undefined : resolveChannel(ctx.dir, flags.channel),
        onlyApps: flags.onlyApp ?? [],
        excludeApps: flags.excludeApp ?? [],
        refresh: Boolean(flags.refresh),
        cacheDir: ctx.dir,
        ownKeys: config?.keys,
      });
      rememberFeed(ctx.dir, items);
      ctx.print(items, renderFeed(items, now, feedStyle(io)));
      if (ctx.json) return;
      if (items.length === 0) {
        ctx.note(
          "follow accounts with casty follow @name, or loosen --since, --channel and the app filters",
        );
      } else if (io.stdout.isTTY) {
        ctx.note('act on a cast by its number: casty like 1, casty reply 1 "text", casty thread 1');
      }
    });
}
