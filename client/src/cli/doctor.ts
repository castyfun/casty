import type { Command } from "commander";
import { readConfig } from "../config.js";
import type { NodeInfo } from "../node/http.js";
import { contextFor, type Io } from "./context.js";
import { table } from "./format.js";

/** A shard is synced when its newest block is under 10 seconds old. */
const SYNCED_BELOW_SECONDS = 10;

export interface SyncStatus {
  version: string;
  synced: boolean;
  shards: { shard: number; blockDelay: number; maxHeight: number }[];
}

export function syncStatus(info: NodeInfo): SyncStatus {
  const shards = info.shardInfos.map((s) => ({
    shard: s.shardId,
    blockDelay: s.blockDelay,
    maxHeight: s.maxHeight,
  }));
  const synced = shards.length > 0 && shards.every((s) => s.blockDelay < SYNCED_BELOW_SECONDS);
  return { version: info.version, synced, shards };
}

export function syncRows(status: SyncStatus): string[][] {
  return [
    ["synced", status.synced ? "yes" : "no"],
    ...status.shards.map((s) => [
      `shard ${s.shard}`,
      `${s.blockDelay}s behind, height ${s.maxHeight}`,
    ]),
  ];
}

export function registerDoctor(program: Command, io: Io): void {
  program
    .command("doctor")
    .description("check the node, its sync, the local clock and the local setup")
    .action(async (_options, command: Command) => {
      const ctx = contextFor(command, io);
      const { info, date } = await ctx.node.info();
      const status = syncStatus(info);
      const clockSkewSeconds = date ? Math.round((Date.now() - date.getTime()) / 1000) : null;
      const config = readConfig(ctx.dir);
      const keyPresent = (config?.keys.length ?? 0) > 0;
      const result = {
        node: ctx.node.url,
        ...status,
        clockSkewSeconds,
        configDir: ctx.dir,
        fid: config?.fid ?? null,
        keyPresent,
      };
      const rows = [
        ["node", `${ctx.node.url} (snapchain ${status.version})`],
        ...syncRows(status),
        ["clock skew", clockSkewSeconds === null ? "unknown" : `${clockSkewSeconds}s`],
        ["config", ctx.dir],
        ["app key", keyPresent ? `yes, fid ${config?.fid}` : "none yet, run casty init"],
      ];
      ctx.print(result, table(rows));
      if (clockSkewSeconds !== null && Math.abs(clockSkewSeconds) > 60) {
        ctx.note(
          "warning: this clock and the node's differ by over a minute; nodes reject messages from the future",
        );
      }
    });
}
