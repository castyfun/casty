import type { Command } from "commander";
import { readConfig } from "../config.js";
import { describeSigners, type SignerRow } from "../feed/clients.js";
import { scopeGroupsOfNames } from "../protocol/scopes.js";
import { type Context, contextFor, type Io, requireConfig } from "./context.js";
import { aboveZero, shortKey, table } from "./format.js";

export async function signerTable(rows: SignerRow[]): Promise<string> {
  if (rows.length === 0) return "no keys";
  // "cast, reaction, link", as --scopes names them.
  const groups = (names: string[]) => scopeGroupsOfNames(names).join(", ");
  return table([
    ["KEY", "TYPE", "APP", "SCOPES", "EXPIRES", "OURS"],
    ...rows.map((r) => [
      shortKey(r.key),
      r.type,
      r.requestFid === null ? "-" : `${r.app ? `@${r.app}` : "?"} (${r.requestFid})`,
      r.type === "onchain" ? "all" : groups(r.scopes),
      r.expiresAt?.slice(0, 10) ?? "-",
      r.ours ? "yes" : "",
    ]),
  ]);
}

/** Signer rows for `fid` (default: the configured fid), marking keys in our store. */
export async function signerRows(ctx: Context, fid: number | undefined): Promise<SignerRow[]> {
  const config = fid === undefined ? requireConfig(ctx) : readConfig(ctx.dir);
  const target = fid ?? (config?.fid as number);
  return describeSigners(ctx.node, target, config?.fid === target ? config.keys : []);
}

export function registerClients(program: Command, io: Io): void {
  program
    .command("clients")
    .description("the app keys of a fid and which app requested each")
    .option("--fid <fid>", "whose keys (default: yours)", aboveZero)
    .action(async (options: { fid?: number }, command: Command) => {
      const ctx = contextFor(command, io);
      const rows = await signerRows(ctx, options.fid);
      ctx.print(rows, await signerTable(rows));
    });
}
