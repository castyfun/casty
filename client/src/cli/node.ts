import type { Command } from "commander";
import { CastyError } from "../errors.js";
import { contextFor, type Io } from "./context.js";
import { syncRows, syncStatus } from "./doctor.js";

export function registerNode(program: Command, io: Io): void {
  const node = program.command("node").description("about the node itself");
  node
    .command("status")
    .description("sync status only, for scripts: exit code 1 until synced")
    .action(async (_options, command: Command) => {
      const ctx = contextFor(command, io);
      const status = syncStatus((await ctx.node.info()).info);
      ctx.print(
        status,
        syncRows(status)
          .map((row) => row.join("  "))
          .join("\n"),
      );
      if (!status.synced) throw new CastyError("the node is not synced yet", 1);
    });
}
