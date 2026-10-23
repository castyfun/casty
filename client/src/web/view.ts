import { castUrl } from "../config.js";
import { clean, type FeedItem, formatAge, type Mention, who } from "../feed/render.js";
import type { NodeMessage } from "../node/http.js";

/** A run of cast text: plain text, a mention, or an http(s) link. The page renders each as is. */
export type Segment = { text: string } | { mention: string; fid: number } | { link: string };

/**
 * A cast as the page shows it: what it draws and nothing more. The text and mentions travel as
 * segments; the signer and the raw timestamp stay on the server.
 */
export interface WebCast extends Omit<FeedItem, "text" | "mentions" | "signer" | "timestamp"> {
  age: string;
  segments: Segment[];
  url: string | null;
  liked: boolean;
  recast: boolean;
}

const _BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface Verification {
  protocol: "ethereum" | "solana";
  address: string;
}

/** A verified address as the page shows it; undefined for a message of another kind. */
export function verificationOf(message: NodeMessage): Verification | undefined {
  const body = message.data.verificationAddAddressBody;
  if (!body?.address) return undefined;
  if (body.protocol === "PROTOCOL_SOLANA") {
    // Snapchain prints a Solana address as base58 already (seen on a mainnet node for fid 3).
    return { protocol: "solana", address: body.address };
  }
  return { protocol: "ethereum", address: body.address.toLowerCase() };
}

/** `fid:hash` keys of the casts you liked and recast. */
export interface Reacted {
  likes: Set<string>;
  recasts: Set<string>;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]'"]+$/;
const isHttp = (url: string) => /^https?:\/\//i.test(url);

function links(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const link = match[0].replace(TRAILING, "");
    if (match.index > at) out.push({ text: text.slice(at, match.index) });
    out.push({ link });
    at = match.index + link.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Cleans each line and keeps at most one blank line in a row. */
export const tidy = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map(clean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

/** The text split at its mentions (by UTF-8 byte offset) and links, cleaned and trimmed. */
export function segments(text: string, mentions: Mention[]): Segment[] {
  const bytes = Buffer.from(text, "utf8");
  const pieces: (string | Mention)[] = [];
  let at = 0;
  for (const mention of mentions.toSorted((a, b) => a.position - b.position)) {
    pieces.push(bytes.subarray(at, mention.position).toString("utf8"), mention);
    at = Math.max(at, mention.position);
  }
  pieces.push(bytes.subarray(at).toString("utf8"));

  const last = pieces.length - 1;
  return pieces.flatMap((piece, i) => {
    if (typeof piece !== "string") return [{ mention: who(piece.name, piece.fid), fid: piece.fid }];
    let text = tidy(piece);
    if (i === 0) text = text.trimStart();
    if (i === last) text = text.trimEnd();
    return text ? links(text) : [];
  });
}

/** `now` is Farcaster seconds. */
export function toWebCast(item: FeedItem, now: number, reacted: Reacted): WebCast {
  const key = `${item.fid}:${item.hash}`;
  const { text, mentions, signer: _, timestamp, ...shown } = item;
  return {
    ...shown,
    embeds: item.embeds.filter(isHttp),
    age: formatAge(Math.max(0, now - timestamp)),
    segments: segments(text, mentions),
    url: item.author ? castUrl(item.author, item.hash) : null,
    liked: reacted.likes.has(key),
    recast: reacted.recasts.has(key),
  };
}
