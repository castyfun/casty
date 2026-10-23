import {
  type CastId,
  CastType,
  FarcasterNetwork,
  type HubResult,
  type Message,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  type ReactionType,
  type Signer,
} from "@farcaster/core";
import { UsageError } from "../errors.js";
import { encodeMentions } from "./mentions.js";

export const NETWORK = FarcasterNetwork.MAINNET;
export const MAX_CAST_BYTES = 320;
export const MAX_LONG_CAST_BYTES = 1024;

export interface CastInput {
  text: string;
  parent?: CastId | undefined;
  channel?: string | undefined;
  embeds?: string[] | undefined;
  /** Fids by lowercase name: each @name of the text found here goes out as a mention. */
  mentions?: ReadonlyMap<string, number> | undefined;
}

/** Message builders only fail on invalid input, so their errors are usage errors. */
export function unwrap<T>(result: HubResult<T>): T {
  if (result.isErr()) throw new UsageError(result.error.message);
  return result.value;
}

/** CAST up to 320 UTF-8 bytes, LONG_CAST up to 1024; anything longer is refused. */
export function castTypeFor(text: string): CastType {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_CAST_BYTES) return CastType.CAST;
  if (bytes <= MAX_LONG_CAST_BYTES) return CastType.LONG_CAST;
  throw new UsageError(`the cast is ${bytes} bytes; the limit is ${MAX_LONG_CAST_BYTES}`);
}

export async function buildCast(fid: number, input: CastInput, signer: Signer): Promise<Message> {
  if (input.parent && input.channel) {
    throw new UsageError("a cast is either a reply or a channel post, not both");
  }
  // The byte limits count the text without the mentions, as the protocol does.
  const { text, mentions, mentionsPositions } = encodeMentions(
    input.text,
    input.mentions ?? new Map(),
  );
  const body = {
    text,
    type: castTypeFor(text),
    embeds: (input.embeds ?? []).map((url) => ({ url })),
    embedsDeprecated: [],
    mentions,
    mentionsPositions,
    parentCastId: input.parent,
    parentUrl: input.channel,
  };
  // declare const makeCastAdd: (body: CastAddBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<CastAddMessage>;
  return unwrap(await makeCastAdd(body, { fid, network: NETWORK }, signer));
}

export async function buildCastRemove(
  fid: number,
  hash: Uint8Array,
  signer: Signer,
): Promise<Message> {
  // declare const makeCastRemove: (body: CastRemoveBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<CastRemoveMessage>;
  return unwrap(await makeCastRemove({ targetHash: hash }, { fid, network: NETWORK }, signer));
}

export async function buildReaction(
  kind: "add" | "remove",
  fid: number,
  type: ReactionType,
  target: CastId,
  signer: Signer,
): Promise<Message> {
  // declare const makeReactionAdd: (body: ReactionBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<ReactionAddMessage>;
  // declare const makeReactionRemove: (body: ReactionBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<ReactionRemoveMessage>;
  const body = { type, targetCastId: target };
  const options = { fid, network: NETWORK };
  return kind === "add"
    ? unwrap(await makeReactionAdd(body, options, signer))
    : unwrap(await makeReactionRemove(body, options, signer));
}

export async function buildLink(
  kind: "add" | "remove",
  fid: number,
  targetFid: number,
  signer: Signer,
): Promise<Message> {
  // declare const makeLinkAdd: (body: LinkBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<LinkAddMessage>;
  // declare const makeLinkRemove: (body: LinkBody, dataOptions: MessageDataOptions, signer: Signer) => HubAsyncResult<LinkRemoveMessage>;
  const body = { type: "follow", targetFid };
  const options = { fid, network: NETWORK };
  return kind === "add"
    ? unwrap(await makeLinkAdd(body, options, signer))
    : unwrap(await makeLinkRemove(body, options, signer));
}
