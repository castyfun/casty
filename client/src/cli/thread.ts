import type { Command } from "commander";
import { readConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { describeCasts, readThread, threadCasts } from "../feed/feed.js";
import { renderFeed } from "../feed/render.js";
import { farcasterNow } from "../protocol/time.js";
import { contextFor, type Io } from "./context.js";
import { feedStyle } from "./format.js";
import { CAST_REF_FORMS, rememberFeed, resolveCast } from "./refs.js";

export function registerThread(program: Command, io: Io): void {
  program
    .command("thread")
    .description("a cast with what it answers and its replies, numbered as the feed is")
    .argument("<cast>", `the cast: ${CAST_REF_FORMS}`)
    .action(async (ref: string, _flags, command: Command) => {
      const ctx = contextFor(command, io);
      const id = await resolveCast(ctx, ref);
      const thread = await readThread(ctx.node, id);
      if (!thread) throw new UsageError(`fid ${id.fid} has no cast ${id.hash}`);
      const options = { cacheDir: ctx.dir, ownKeys: readConfig(ctx.dir)?.keys };
      const items = await describeCasts(ctx.node, threadCasts(thread), options);
      rememberFeed(ctx.dir, items);
      const [cast, ...replies] = thread.parent ? items.slice(1) : items;
      const json = { parent: thread.parent ? items[0] : null, cast, replies };
      ctx.print(json, renderFeed(items, farcasterNow(), feedStyle(io)));
      if (!ctx.json && replies.length === 0) ctx.note("no replies yet");
    });
}
