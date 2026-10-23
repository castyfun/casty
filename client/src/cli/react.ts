import type { Command } from "commander";
import type { ReactionKind } from "../node/http.js";
import { contextFor, type Io, signing, withAppKey } from "./context.js";
import { CAST_REF_FORMS, resolveCast } from "./refs.js";

const COMMANDS: [string, "add" | "remove", ReactionKind, string, string][] = [
  ["like", "add", "Like", "like a cast", "liked"],
  ["unlike", "remove", "Like", "take a like back", "unliked"],
  ["recast", "add", "Recast", "recast a cast to your followers", "recast"],
  ["unrecast", "remove", "Recast", "take a recast back", "unrecast"],
];

export function registerReact(program: Command, io: Io): void {
  for (const [name, kind, reaction, description, done] of COMMANDS) {
    program
      .command(name)
      .description(description)
      .argument("<cast>", `the cast: ${CAST_REF_FORMS}`)
      .action(async (ref: string, _flags, command: Command) => {
        const ctx = contextFor(command, io);
        const target = await resolveCast(ctx, ref);
        const actions = signing();
        await withAppKey(ctx, async (signer, config) => {
          const { react } = await actions;
          const writer = { node: ctx.node, fid: config.fid, signer, confirm: ctx.confirm };
          await react(writer, kind, reaction, target);
          const ref = `${target.fid}:${target.hash}`;
          ctx.print({ [name]: ref }, `${done} ${ref}`);
        });
      });
  }
}
