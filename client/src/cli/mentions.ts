import type { Command } from "commander";
import { loadMentions } from "../feed/feed.js";
import { renderFeed } from "../feed/render.js";
import { farcasterNow } from "../protocol/time.js";
import { contextFor, type Io, requireConfig } from "./context.js";
import { aboveZero, feedStyle } from "./format.js";
import { rememberFeed, sawMentions } from "./refs.js";

export function registerMentions(program: Command, io: Io): void {
  program
    .command("mentions")
    .description("casts that mention you and replies to your casts, newest first")
    .option("--limit <n>", "how many casts", aboveZero, 30)
    .action(async (flags: { limit: number }, command: Command) => {
      const ctx = contextFor(command, io);
      const config = requireConfig(ctx);
      const items = await loadMentions(ctx.node, {
        fid: config.fid,
        limit: flags.limit,
        cacheDir: ctx.dir,
        ownKeys: config.keys,
      });
      rememberFeed(ctx.dir, items);
      sawMentions(ctx.dir, config.fid, items);
      ctx.print(items, renderFeed(items, farcasterNow(), feedStyle(io)));
      if (!ctx.json && items.length === 0) {
        ctx.note("nobody has mentioned you or replied to your newest casts yet");
      }
    });
}
