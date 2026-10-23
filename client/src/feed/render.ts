import type { CastId, Hex, NodeMessage } from "../node/http.js";
import { farcasterToDate } from "../protocol/time.js";

export interface AppLabel {
  fid: number;
  name: string | null;
}

/** A mention as the protocol stores it: the fid and the UTF-8 byte offset it sits at. */
export interface Mention {
  fid: number;
  position: number;
  name: string | null;
}

/** One cast as `casty feed --json` prints it. Absent values are null so every item has every key. */
export interface FeedItem {
  fid: number;
  hash: Hex;
  /** Farcaster seconds. */
  timestamp: number;
  time: string;
  author: string | null;
  app: AppLabel | null;
  text: string;
  parent: CastId | null;
  parentAuthor: string | null;
  channel: string | null;
  embeds: string[];
  mentions: Mention[];
  signer: Hex;
  /** Signed with one of this casty's app keys. */
  ours: boolean;
}

export function toFeedItem(cast: NodeMessage): FeedItem {
  const body = cast.data.castAddBody;
  return {
    fid: cast.data.fid,
    hash: cast.hash,
    timestamp: cast.data.timestamp,
    time: farcasterToDate(cast.data.timestamp).toISOString(),
    author: null,
    app: null,
    text: body?.text ?? "",
    parent: body?.parentCastId ?? null,
    parentAuthor: null,
    channel: body?.parentUrl ?? null,
    embeds: (body?.embeds ?? []).flatMap((e) => (e.url ? [e.url] : [])),
    mentions: (body?.mentions ?? []).map((fid, i) => ({
      fid,
      position: body?.mentionsPositions[i] ?? 0,
      name: null,
    })),
    signer: cast.signer,
    ours: false,
  };
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** `!<fid>` stands in for a name the node does not know. */
export const who = (name: string | null, fid: number) => (name ? `@${name}` : `!${fid}`);

/** Mentions live outside the text; this puts `@name` (or `!fid`) back at each byte offset. */
export function withMentions(text: string, mentions: Mention[]): string {
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  let at = 0;
  for (const mention of mentions.toSorted((a, b) => a.position - b.position)) {
    out += bytes.subarray(at, mention.position).toString("utf8") + who(mention.name, mention.fid);
    at = Math.max(at, mention.position);
  }
  return out + bytes.subarray(at).toString("utf8");
}

// Casts are written by strangers: drop C0/C1 controls (escape sequences) and bidi overrides
// before anything reaches the terminal. Line breaks are split off first and kept.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const clean = (text: string) => text.replace(/\t/g, " ").replace(UNSAFE, "");

export interface RenderOptions {
  /** Columns to wrap to; never more than 100, so long lines stay readable. */
  width: number;
  /** Bold and dim ANSI styles, for a terminal. */
  color: boolean;
}

const MAX_WIDTH = 100;

/** Greedy word wrap; a word longer than the width, such as a URL, gets a line of its own. */
export function wrap(line: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  return [...lines, current];
}

/** The cast's paragraphs, cleaned and wrapped; runs of blank lines become one. */
function paragraphs(text: string, width: number): string[] {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => clean(line).replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return lines === "" ? [] : lines.split("\n").flatMap((line) => (line ? wrap(line, width) : [""]));
}

/** `/name` for a channel url ending in `/~/channel/name`, the url itself otherwise. */
export const channelLabel = (url: string) => {
  const name = /\/~\/channel\/([^/?#]+)$/.exec(url)?.[1];
  return name ? `/${name}` : url;
};

/**
 * Each cast as a numbered block: author, age, app and what it replies to on the first line,
 * then its text wrapped to the width, then its links. `now` is Farcaster seconds.
 */
export function renderFeed(items: FeedItem[], now: number, options: RenderOptions): string {
  if (items.length === 0) return "no casts";
  const style = (code: number) => (text: string) =>
    options.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const [bold, dim, cyan] = [style(1), style(2), style(36)];
  const numberWidth = String(items.length).length;
  const indent = " ".repeat(numberWidth + 2);
  const textWidth = Math.max(10, Math.min(options.width, MAX_WIDTH) - indent.length);

  return items
    .map((item, i) => {
      const details = [
        formatAge(Math.max(0, now - item.timestamp)),
        item.ours
          ? "via casty"
          : item.app && `via ${who(item.app.name, item.app.fid).replace(/^@/, "")}`,
        item.parent && `reply to ${who(item.parentAuthor, item.parent.fid)}`,
        item.channel && `in ${channelLabel(item.channel)}`,
      ].filter((detail) => typeof detail === "string");
      const header =
        dim(String(i + 1).padStart(numberWidth)) +
        "  " +
        bold(clean(who(item.author, item.fid))) +
        dim(clean(details.map((detail) => ` · ${detail}`).join("")));
      const text = paragraphs(withMentions(item.text, item.mentions), textWidth).map((line) =>
        line ? indent + line : "",
      );
      const links = item.embeds.map((url) => indent + cyan(clean(url)));
      return [header, ...text, ...links].join("\n");
    })
    .join("\n\n");
}
