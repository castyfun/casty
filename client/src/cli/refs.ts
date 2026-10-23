import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diskCache, FNAME_SERVER, namesCache, writeAtomic } from "../config.js";
import { fidForName } from "../custody/fid.js";
import { UsageError } from "../errors.js";
import { channelLabel } from "../feed/render.js";
import { allPages, type CastId, type Hex } from "../node/http.js";
import type { Context } from "./context.js";

const LAST_FEED = "last-feed.json";
/** The channels lists have shown, by the /name they showed them as. A channel's url stays put. */
const channels = (dir: string) => diskCache<string>(dir, "channels", Number.POSITIVE_INFINITY);
/** The newest mention each fid has been shown, by fid; casty web counts the ones after it. */
const seenMentions = (dir: string) =>
  diskCache<number>(dir, "mentions-seen", Number.POSITIVE_INFINITY);
/** How far back a link's short hash is looked for among its author's casts. */
const LINK_SEARCH = 1000;

/** The ways to name a cast, for help text: "the cast: " + CAST_REF_FORMS. */
export const CAST_REF_FORMS =
  "its number in the last list shown (casty feed, mentions, thread or web), <fid>:<0x hash>, or its farcaster.xyz link";

/**
 * Keeps the casts `casty feed` just numbered, so `casty like 2` means the second one shown, and
 * the channels it showed, so `--channel /name` means the one shown as /name.
 */
export function rememberFeed(dir: string, casts: (CastId & { channel?: string | null })[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const refs = casts.map(({ fid, hash }) => ({ fid, hash }));
  // A terminal and a browser page may both be numbering casts.
  writeAtomic(join(dir, LAST_FEED), `${JSON.stringify(refs)}\n`);
  const known = channels(dir);
  let added = false;
  for (const { channel } of casts) {
    const name = channel ? channelLabel(channel) : "";
    if (channel && name.startsWith("/") && known.get(name) !== channel) {
      known.set(name, channel);
      added = true;
    }
  }
  if (added) known.save();
}

/** Notes that `fid` has been shown these mentions, so casty web counts only newer ones. */
export function sawMentions(dir: string, fid: number, casts: { timestamp: number }[]): void {
  const seen = seenMentions(dir);
  seen.set(String(fid), Math.max(seen.get(String(fid)) ?? 0, ...casts.map((c) => c.timestamp)));
  seen.save();
}

/**
 * How many of these mention timestamps are newer than any `fid` has been shown; the first count
 * starts from now. ponytail: by time, so a mention that reaches the node after a newer one was
 * shown is not counted; keep the hashes shown if late syncs make that matter.
 */
export function unseenMentions(dir: string, fid: number, timestamps: number[]): number {
  const seen = seenMentions(dir);
  const since = seen.get(String(fid));
  if (since !== undefined) return timestamps.filter((t) => t > since).length;
  seen.set(String(fid), Math.max(0, ...timestamps));
  seen.save();
  return 0;
}

/** A channel named on the command line: its parent url, or the /name a list showed it as. */
export function resolveChannel(dir: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  const name = ref.startsWith("/") ? ref : `/${ref}`;
  const url = channels(dir).get(name);
  if (url) return url;
  throw new UsageError(
    `no channel ${name} shown yet`,
    "casty knows a channel by name once a list has shown one of its casts; or pass its parent url",
  );
}

/** A cast named on the command line, in any of the forms CAST_REF_FORMS lists. */
export async function resolveCast(ctx: Context, ref: string): Promise<CastId> {
  if (/^\d{1,4}$/.test(ref)) return fromLastFeed(ctx.dir, Number(ref));
  const id = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(ref);
  if (id) return { fid: Number(id[1]), hash: (id[2] as string).toLowerCase() as Hex };
  const link = /^https:\/\/farcaster\.xyz\/([^/\s]+)\/(0x[0-9a-fA-F]{8,40})$/.exec(ref);
  if (link) return fromLink(ctx, link[1] as string, (link[2] as string).toLowerCase());
  throw new UsageError(`cannot tell which cast "${ref}" is`, `name it by ${CAST_REF_FORMS}`);
}

function fromLastFeed(dir: string, n: number): CastId {
  let refs: CastId[];
  try {
    refs = JSON.parse(readFileSync(join(dir, LAST_FEED), "utf8"));
  } catch {
    throw new UsageError(
      `no list numbered yet to take cast ${n} from`,
      "run casty feed or casty mentions first",
    );
  }
  const cast = refs[n - 1];
  if (!cast) {
    throw new UsageError(`the last list numbered has no cast ${n}`, `it showed ${refs.length}`);
  }
  return cast;
}

/** The link carries the author's name and the hash's first characters; the node has the rest. */
async function fromLink(ctx: Context, name: string, prefix: string): Promise<CastId> {
  const names = namesCache(ctx.dir);
  const fid = await fidForName(ctx.node, name, FNAME_SERVER, names);
  let seen = 0;
  for await (const cast of allPages((pageToken) =>
    ctx.node.castsByFid(fid, { pageToken, reverse: true }),
  )) {
    if (cast.hash.startsWith(prefix)) return { fid, hash: cast.hash };
    if (++seen >= LINK_SEARCH) break;
  }
  throw new UsageError(`@${name} has no recent cast whose hash starts with ${prefix}`);
}
