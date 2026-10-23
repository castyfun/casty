import type { Command } from "commander";
import { FNAME_SERVER, namesCache } from "../config.js";
import { fidForName } from "../custody/fid.js";
import type { Hex } from "../node/http.js";
import { mentionFids } from "../protocol/mentions.js";
import {
  type Context,
  contextFor,
  type Io,
  requireConfig,
  signing,
  withAppKey,
} from "./context.js";
import { collect } from "./format.js";
import { CAST_REF_FORMS, resolveCast, resolveChannel } from "./refs.js";

interface CastFlags {
  reply?: string;
  channel?: string;
  embed?: string[];
  mentions?: boolean;
  allowFnameServer?: boolean;
}

/** The options of the commands that send text: cast and reply. */
const mentionOptions = (command: Command): Command =>
  command
    .option("--no-mentions", "send @names as text, not as mentions")
    .option(
      "--no-allow-fname-server",
      "look @names up with your node only; by default names it does not know are looked up on fnames.farcaster.xyz (public, no key)",
    );

async function publish(ctx: Context, text: string, flags: CastFlags): Promise<void> {
  const parent = flags.reply === undefined ? undefined : await resolveCast(ctx, flags.reply);
  const channel = flags.channel === undefined ? undefined : resolveChannel(ctx.dir, flags.channel);
  // Looked up before the passphrase is asked for; a name nobody holds goes out as text.
  const server = flags.allowFnameServer === false ? undefined : FNAME_SERVER;
  const { fids, plain } =
    flags.mentions === false
      ? { fids: new Map<string, number>(), plain: [] }
      : await mentionFids(text, (name) => fidForName(ctx.node, name, server, namesCache(ctx.dir)));
  for (const name of plain) ctx.note(`no account is called @${name}; it goes out as text`);
  const actions = signing();
  await withAppKey(ctx, async (signer, config) => {
    const { postCast } = await actions;
    const writer = { node: ctx.node, fid: config.fid, signer, confirm: ctx.confirm };
    const cast = { text, parent, channel, embeds: flags.embed, mentions: fids };
    const { fid, hash, url } = await postCast(writer, cast);
    ctx.print({ fid, hash, url }, url ? `${hash}\n${url}` : hash);
  });
}

export function registerCast(program: Command, io: Io): void {
  mentionOptions(
    program
      .command("cast")
      .description("publish a cast (up to 320 bytes, or 1024 as a long cast)")
      .argument("<text>", "what to say; @names go out as mentions")
      .option("--reply <cast>", `reply to this cast: ${CAST_REF_FORMS}`)
      .option("--channel <channel>", "post in this channel: its parent url, or /name once shown")
      .option("--embed <url>", "embed a url (repeatable)", collect),
  ).action((text: string, flags: CastFlags, command: Command) =>
    publish(contextFor(command, io), text, flags),
  );

  mentionOptions(
    program
      .command("reply")
      .description("reply to a cast; same as cast --reply")
      .argument("<cast>", `the cast: ${CAST_REF_FORMS}`)
      .argument("<text>", "what to say; @names go out as mentions"),
  ).action((parent: string, text: string, flags: CastFlags, command: Command) =>
    publish(contextFor(command, io), text, { ...flags, reply: parent }),
  );

  program
    .command("delete")
    .description("delete one of your casts")
    .argument("<cast>", `your cast: its 0x hash, ${CAST_REF_FORMS}`)
    .action(async (ref: string, _flags, command: Command) => {
      const ctx = contextFor(command, io);
      // Named before the passphrase is asked for, so a typo costs no typing.
      const target = /^0x[0-9a-fA-F]{40}$/.test(ref)
        ? { fid: requireConfig(ctx).fid, hash: ref.toLowerCase() as Hex }
        : await resolveCast(ctx, ref);
      const actions = signing();
      await withAppKey(ctx, async (signer, config) => {
        const { deleteCast } = await actions;
        await deleteCast({ node: ctx.node, fid: config.fid, signer, confirm: ctx.confirm }, target);
        ctx.print({ deleted: target.hash }, `deleted ${target.hash}`);
      });
    });
}
