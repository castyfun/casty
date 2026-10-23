import { ReactionType, type Signer } from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { castUrl } from "../config.js";
import { UsageError } from "../errors.js";
import type { CastId, Hex, NodeClient, ReactionKind } from "../node/http.js";
import { buildCast, buildCastRemove, buildLink, buildReaction } from "../protocol/messages.js";
import { type ConfirmOptions, submitAndConfirm } from "./confirm.js";

/** What every write needs: the node, whose fid it is, the app key and how long to wait. */
export interface Writer {
  node: NodeClient;
  fid: number;
  signer: Signer;
  confirm: ConfirmOptions;
}

export interface NewCast {
  text: string;
  parent?: CastId | undefined;
  channel?: string | undefined;
  embeds?: string[] | undefined;
  /** Fids by lowercase name: each @name of the text found here goes out as a mention. */
  mentions?: ReadonlyMap<string, number> | undefined;
}

const toProtocol = (id: CastId) => ({ fid: id.fid, hash: hexToBytes(id.hash) });

/**
 * Publishes a cast and waits until the node has it. `url` needs the username, read alongside
 * the wait; it is null without one, or when that read fails, since the cast is out either way.
 */
export async function postCast(
  w: Writer,
  cast: NewCast,
): Promise<{ fid: number; hash: Hex; url: string | null }> {
  const input = { ...cast, parent: cast.parent && toProtocol(cast.parent) };
  const message = await buildCast(w.fid, input, w.signer);
  const hash = bytesToHex(message.hash);
  const username = w.node
    .userDataByFid(w.fid, "USER_DATA_TYPE_USERNAME")
    .then(([data]) => data?.data.userDataBody?.value)
    .catch(() => undefined);
  await submitAndConfirm(
    w.node,
    message,
    async () => (await w.node.castById(w.fid, hash)) !== undefined,
    w.confirm,
  );
  const name = await username;
  return { fid: w.fid, hash, url: name ? castUrl(name, hash) : null };
}

/** Removes one of the writer's own casts and waits until the node no longer has it. */
export async function deleteCast(w: Writer, target: CastId): Promise<void> {
  if (target.fid !== w.fid) {
    throw new UsageError(`that cast is by fid ${target.fid}, not yours (${w.fid})`);
  }
  if (!(await w.node.castById(w.fid, target.hash))) {
    throw new UsageError(`fid ${w.fid} has no cast ${target.hash}`);
  }
  const message = await buildCastRemove(w.fid, hexToBytes(target.hash), w.signer);
  await submitAndConfirm(
    w.node,
    message,
    async () => (await w.node.castById(w.fid, target.hash)) === undefined,
    w.confirm,
  );
}

/** Adds or removes a like or recast and waits until the cast's reactions show it. */
export async function react(
  w: Writer,
  kind: "add" | "remove",
  reaction: ReactionKind,
  target: CastId,
): Promise<void> {
  const type = reaction === "Like" ? ReactionType.LIKE : ReactionType.RECAST;
  const message = await buildReaction(kind, w.fid, type, toProtocol(target), w.signer);
  await submitAndConfirm(
    w.node,
    message,
    async () =>
      ((await w.node.reactionById(w.fid, reaction, target)) !== undefined) === (kind === "add"),
    w.confirm,
  );
}

/** Follows or unfollows `target` and waits until the node has that follow, or no longer has it. */
export async function follow(w: Writer, kind: "add" | "remove", target: number): Promise<void> {
  const message = await buildLink(kind, w.fid, target, w.signer);
  await submitAndConfirm(
    w.node,
    message,
    async () => ((await w.node.linkById(w.fid, target)) !== undefined) === (kind === "add"),
    w.confirm,
  );
}
