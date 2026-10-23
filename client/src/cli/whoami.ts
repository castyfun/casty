import type { Command } from "commander";
import { contextFor, type Io, requireConfig } from "./context.js";
import { table, units } from "./format.js";

export function registerWhoami(program: Command, io: Io): void {
  program
    .command("whoami")
    .description("your fid, username, custody address, active app key and storage")
    .action(async (_options, command: Command) => {
      const ctx = contextFor(command, io);
      const config = requireConfig(ctx);
      const [[username], { signers }, storage] = await Promise.all([
        ctx.node.userDataByFid(config.fid, "USER_DATA_TYPE_USERNAME"),
        ctx.node.signersByFid(config.fid),
        ctx.node.storageLimitsByFid(config.fid),
      ]);
      const activeKey = config.keys.findLast((key) => signers.some((s) => s.key === key)) ?? null;
      const result = {
        fid: config.fid,
        username: username?.data.userDataBody?.value ?? null,
        custodyAddress: config.custodyAddress,
        activeKey,
        storage: {
          units: storage.units,
          ...Object.fromEntries(
            storage.limits.map((l) => [l.name, { used: l.used, limit: l.limit }]),
          ),
        },
      };
      const usage = storage.limits.map((l) => `${l.name} ${l.used}/${l.limit}`).join(", ");
      ctx.print(
        result,
        table([
          ["fid", String(result.fid)],
          ["username", result.username ? `@${result.username}` : "none"],
          ["custody", result.custodyAddress],
          ["app key", activeKey ?? "none active, run casty init"],
          ["storage", `${units(storage.units)}: ${usage}`],
        ]),
      );
    });
}
