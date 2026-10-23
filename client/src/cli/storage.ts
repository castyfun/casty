import type { Command } from "commander";
import { contextFor, type Io, requireConfig } from "./context.js";
import { aboveZero, table, units } from "./format.js";

const WARN_AT = 0.9;

export function registerStorage(program: Command, io: Io): void {
  program
    .command("storage")
    .description("storage units and how full each message store is")
    .option("--fid <fid>", "whose storage (default: yours)", aboveZero)
    .action(async (options: { fid?: number }, command: Command) => {
      const ctx = contextFor(command, io);
      const fid = options.fid ?? requireConfig(ctx).fid;
      const storage = await ctx.node.storageLimitsByFid(fid);
      const stores = storage.limits.map((l) => ({
        store: l.name,
        used: l.used,
        limit: l.limit,
        percent: l.limit > 0 ? Math.round((l.used / l.limit) * 100) : 0,
      }));
      const warnings = stores
        .filter((s) => s.limit > 0 && s.used / s.limit >= WARN_AT)
        .map(
          (s) =>
            `warning: ${s.store} is ${s.percent}% full; when it fills, the oldest messages of that kind are pruned`,
        );
      if (storage.units === 0)
        warnings.push(
          "warning: no storage units; the network will not accept messages from this fid",
        );
      const text = [
        `fid ${fid}: ${units(storage.units)}`,
        table([
          ["STORE", "USED", "LIMIT", "%"],
          ...stores.map((s) => [s.store, String(s.used), String(s.limit), String(s.percent)]),
        ]),
        ...warnings,
      ].join("\n");
      ctx.print({ fid, units: storage.units, stores, warnings }, text);
    });
}
