// "@name" in a cast's text, as people type it, turned into the protocol's mentions: the name is
// taken out of the text and its fid kept with the UTF-8 byte offset where it stood, which is how
// clients show it again (web/view.ts segments). No @farcaster/core here: cast.ts loads this at
// startup.

import { UsageError } from "../errors.js";

/** At most this many mentions in one cast; the protocol refuses more. */
const MAX_MENTIONS = 10;

/**
 * An fname, or an ENS name such as alice.eth, at the start or after a space or "(". It must end
 * the name: never before a letter, digit, "_", "-" or a "." that goes on, so @josé or
 * @jesse.base.eth is never read as @jos or @jesse, which would tag someone else.
 */
const MENTION =
  /(?<=^|[\s(])@([a-z0-9][a-z0-9-]{0,15}(?:\.eth)?)(?![\p{L}\p{N}\p{M}_-]|\.[\p{L}\p{N}])/giu;

/** The @names in `text`, lowercased as fnames are, each once, in order. */
export function mentionedNames(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => (m[1] as string).toLowerCase()))];
}

export interface Mentions {
  text: string;
  mentions: number[];
  mentionsPositions: number[];
}

/** `text` with each @name `fids` knows made a mention; the others stay text. */
export function encodeMentions(text: string, fids: ReadonlyMap<string, number>): Mentions {
  let out = "";
  let from = 0;
  const mentions: number[] = [];
  const mentionsPositions: number[] = [];
  for (const match of text.matchAll(MENTION)) {
    const fid = fids.get((match[1] as string).toLowerCase());
    if (fid === undefined || mentions.length >= MAX_MENTIONS) continue;
    out += text.slice(from, match.index);
    mentionsPositions.push(Buffer.byteLength(out, "utf8"));
    mentions.push(fid);
    from = match.index + match[0].length;
  }
  return { text: out + text.slice(from), mentions, mentionsPositions };
}

/**
 * The fids of the @names in `text`, looked up one by one with `lookup`, and the names it found
 * no fid for (they go out as text). `lookup` says a name is nobody's with a UsageError, as
 * fidForName does; any other failure, an unreachable node say, is thrown, so nothing goes out
 * with a name that may well be someone's sent as text.
 */
export async function mentionFids(
  text: string,
  lookup: (name: string) => Promise<number>,
): Promise<{ fids: Map<string, number>; plain: string[] }> {
  const fids = new Map<string, number>();
  const plain: string[] = [];
  for (const name of mentionedNames(text)) {
    try {
      fids.set(name, await lookup(name));
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      plain.push(name);
    }
  }
  return { fids, plain };
}
