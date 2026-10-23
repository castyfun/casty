import type { Command } from "commander";
import { FNAME_SERVER, namesCache } from "../config.js";
import { fidForName } from "../custody/fid.js";
import { noteFollow } from "../feed/feed.js";
import { contextFor, type Io, signing, withAppKey } from "./context.js";

export function registerFollow(program: Command, io: Io): void {
  for (const [name, kind, description] of [
    ["follow", "add", "follow an account"],
    ["unfollow", "remove", "stop following an account"],
  ] as const) {
    program
      .command(name)
      .description(description)
      .argument("<fid|@name>", "a fid, or a username")
      .option(
        "--no-allow-fname-server",
        "resolve @names with your node only; by default names the node does not know are looked up on fnames.farcaster.xyz (public, no key)",
      )
      .action(async (who: string, flags: { allowFnameServer: boolean }, command: Command) => {
        const ctx = contextFor(command, io);
        const server = flags.allowFnameServer ? FNAME_SERVER : undefined;
        const target = /^\d+$/.test(who)
          ? Number(who)
          : await fidForName(ctx.node, who, server, namesCache(ctx.dir));
        const actions = signing();
        await withAppKey(ctx, async (signer, config) => {
          const { follow } = await actions;
          await follow(
            { node: ctx.node, fid: config.fid, signer, confirm: ctx.confirm },
            kind,
            target,
          );
          noteFollow(ctx.dir, config.fid, target, kind === "add");
          ctx.print(
            { [name]: target },
            `${name === "follow" ? "following" : "no longer following"} ${who}`,
          );
        });
      });
  }
}
