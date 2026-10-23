import { DatabaseSync } from "node:sqlite";
import type { CastId, Hex, NodeMessage, ReactionKind } from "../node/http.js";
import { timely } from "../protocol/time.js";
import type { Reacted } from "../web/view.js";

/**
 * The feed's index: casts of you and your follows, what others said to you, your reactions,
 * your follows and the event cursor, in one SQLite file. Node's own node:sqlite, so no native
 * dependency. Filled by local/indexer.ts; read by casty serve.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS casts (
  hash TEXT PRIMARY KEY,
  fid INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  parent_fid INTEGER,
  parent_hash TEXT,
  parent_url TEXT,
  text TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS casts_fid_ts ON casts(fid, ts);
DROP INDEX IF EXISTS casts_ts;
CREATE INDEX IF NOT EXISTS casts_ts_hash ON casts(ts DESC, hash);
CREATE INDEX IF NOT EXISTS casts_parent ON casts(parent_hash);
CREATE INDEX IF NOT EXISTS casts_parent_fid ON casts(parent_fid, ts);
CREATE TABLE IF NOT EXISTS follows (fid INTEGER NOT NULL, target INTEGER NOT NULL, PRIMARY KEY (fid, target));
CREATE TABLE IF NOT EXISTS reactions (
  fid INTEGER NOT NULL, type TEXT NOT NULL, target_fid INTEGER NOT NULL, target_hash TEXT NOT NULL,
  PRIMARY KEY (fid, type, target_hash)
);
CREATE TABLE IF NOT EXISTS mentions (hash TEXT NOT NULL, fid INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (hash, fid));
CREATE INDEX IF NOT EXISTS mentions_fid_ts ON mentions(fid, ts);
CREATE TABLE IF NOT EXISTS cursor (shard INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface IndexFeedOptions {
  limit: number;
  replies: boolean;
  /** Farcaster seconds; older casts are left out. */
  since?: number | undefined;
  channel?: string | undefined;
  /** The app filters: which of these casts count, decided after a look at their signers. */
  admit?: ((casts: NodeMessage[]) => Promise<NodeMessage[]>) | undefined;
}

export interface LocalIndex {
  /**
   * The newest casts of `fid` and the accounts it follows that pass the filters, newest first,
   * equal times by hash, as the fan-out orders them. Unlike the fan-out, which reads a page of
   * an account and filters it, every cast the index holds is a candidate.
   */
  feed(fid: number, options: IndexFeedOptions): Promise<NodeMessage[]>;
  /** Casts that mention `fid` and replies to its casts, newest first, its own left out. */
  mentions(fid: number, limit: number): NodeMessage[];
  reacted(fid: number): Reacted;
  follows(fid: number): number[];
  setFollow(fid: number, target: number, on: boolean): void;
  setReaction(fid: number, kind: ReactionKind, target: CastId, on: boolean): void;
  /** Keeps a CAST_ADD, once; the same hash again replaces it. */
  upsert(cast: NodeMessage): void;
  /** Drops the cast, if it is `fid`'s: only an author removes a cast. */
  remove(hash: Hex, fid: number): void;
  /**
   * Keeps `fid`'s newest `keep` casts and whatever of its speaks to `me` (a mention or a reply),
   * drops the rest: the fan-out reads no further back, and the file stays small.
   */
  trim(fid: number, keep: number, me: number): void;
  count(fid: number): number;
  /** The feed query's plan, for a test to see it reads the time index and sorts nothing. */
  feedPlan(): string;
  cursor(shard: number): { eventId: number; at: number } | undefined;
  setCursor(shard: number, eventId: number, at: number): void;
  /** When the first pass last finished (ms since the epoch); undefined before one has. */
  ready(): number | undefined;
  setReady(at: number): void;
  /** Runs `fn` in one transaction: a pass of thousands of writes, not thousands of commits. */
  batch(fn: () => void): void;
  close(): void;
}

export function openIndex(path: string): LocalIndex {
  const db = new DatabaseSync(path);
  // ponytail: one writer, so WAL and a normal sync are enough; a crash loses the last poll.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const s = {
    upsert: db.prepare(
      "INSERT OR REPLACE INTO casts (hash, fid, ts, parent_fid, parent_hash, parent_url, text, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    dropMentions: db.prepare("DELETE FROM mentions WHERE hash = ?"),
    mention: db.prepare("INSERT OR IGNORE INTO mentions (hash, fid, ts) VALUES (?, ?, ?)"),
    remove: db.prepare("DELETE FROM casts WHERE hash = ? AND fid = ?"),
    trim: db.prepare(
      `DELETE FROM casts WHERE fid = ?1 AND parent_fid IS NOT ?2
         AND hash NOT IN (SELECT hash FROM mentions WHERE fid = ?2)
         AND hash NOT IN (SELECT hash FROM casts WHERE fid = ?1 ORDER BY ts DESC, hash ASC LIMIT ?3)`,
    ),
    count: db.prepare("SELECT count(*) AS n FROM casts WHERE fid = ?"),
    // `+fid` keeps the planner off the (fid, ts) index: walking the time index newest first
    // and checking each row against the follows costs nothing and sorts nothing.
    feed: db.prepare(
      `SELECT json FROM casts
       WHERE +fid IN (SELECT ?1 UNION SELECT target FROM follows WHERE fid = ?1)
         AND (?2 = 1 OR parent_hash IS NULL) AND ts >= ?3 AND (?4 IS NULL OR parent_url = ?4)
         AND (ts < ?6 OR (ts = ?6 AND hash > ?7))
       ORDER BY ts DESC, hash ASC LIMIT ?5`,
    ),
    mentions: db.prepare(
      `SELECT json FROM casts
       WHERE fid != ?1 AND (parent_fid = ?1 OR hash IN (SELECT hash FROM mentions WHERE fid = ?1))
       ORDER BY ts DESC, hash ASC LIMIT ?2`,
    ),
    reactions: db.prepare("SELECT type, target_fid, target_hash FROM reactions WHERE fid = ?"),
    react: db.prepare(
      "INSERT OR IGNORE INTO reactions (fid, type, target_fid, target_hash) VALUES (?, ?, ?, ?)",
    ),
    unreact: db.prepare("DELETE FROM reactions WHERE fid = ? AND type = ? AND target_hash = ?"),
    follows: db.prepare("SELECT target FROM follows WHERE fid = ? ORDER BY target"),
    follow: db.prepare("INSERT OR IGNORE INTO follows (fid, target) VALUES (?, ?)"),
    unfollow: db.prepare("DELETE FROM follows WHERE fid = ? AND target = ?"),
    cursor: db.prepare("SELECT event_id, at FROM cursor WHERE shard = ?"),
    setCursor: db.prepare("INSERT OR REPLACE INTO cursor (shard, event_id, at) VALUES (?, ?, ?)"),
    meta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
  };
  const rows = (result: unknown[]) => result.map((r) => JSON.parse((r as { json: string }).json));

  return {
    async feed(fid, options) {
      const page = Math.max(options.limit, 50);
      const kept: NodeMessage[] = [];
      // Paged from the last cast seen, not by offset: a cast the tail adds while the app
      // filters look at a page neither repeats one nor hides one.
      let after: { ts: number; hash: string } = { ts: Number.MAX_SAFE_INTEGER, hash: "" };
      while (kept.length < options.limit) {
        const batch: NodeMessage[] = rows(
          s.feed.all(
            fid,
            options.replies ? 1 : 0,
            options.since ?? -1,
            options.channel ?? null,
            page,
            after.ts,
            after.hash,
          ),
        );
        kept.push(...(options.admit ? await options.admit(batch) : batch));
        const last = batch.at(-1);
        if (!last || batch.length < page) break;
        after = { ts: last.data.timestamp, hash: last.hash };
      }
      return kept.slice(0, options.limit);
    },
    feedPlan: () =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${s.feed.sourceSQL}`).all(1, 1, -1, null, 50, 0, "") as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join("\n"),
    mentions: (fid, limit) => rows(s.mentions.all(fid, limit)),
    reacted(fid) {
      const reacted: Reacted = { likes: new Set(), recasts: new Set() };
      for (const row of s.reactions.all(fid) as {
        type: string;
        target_fid: number;
        target_hash: string;
      }[]) {
        (row.type === "Like" ? reacted.likes : reacted.recasts).add(
          `${row.target_fid}:${row.target_hash}`,
        );
      }
      return reacted;
    },
    follows: (fid) => (s.follows.all(fid) as { target: number }[]).map((r) => r.target),
    setFollow(fid, target, on) {
      (on ? s.follow : s.unfollow).run(fid, target);
    },
    setReaction(fid, kind, target, on) {
      if (on) s.react.run(fid, kind, target.fid, target.hash);
      else s.unreact.run(fid, kind, target.hash);
    },
    upsert(cast) {
      const body = cast.data.castAddBody;
      if (!body || !timely(cast)) return;
      s.upsert.run(
        cast.hash,
        cast.data.fid,
        cast.data.timestamp,
        body.parentCastId?.fid ?? null,
        body.parentCastId?.hash ?? null,
        body.parentUrl ?? null,
        body.text,
        JSON.stringify(cast),
      );
      s.dropMentions.run(cast.hash);
      for (const fid of body.mentions ?? []) s.mention.run(cast.hash, fid, cast.data.timestamp);
    },
    remove(hash, fid) {
      if (s.remove.run(hash, fid).changes > 0) s.dropMentions.run(hash);
    },
    trim(fid, keep, me) {
      s.trim.run(fid, me, keep);
    },
    count: (fid) => (s.count.get(fid) as { n: number }).n,
    cursor(shard) {
      const row = s.cursor.get(shard) as { event_id: number; at: number } | undefined;
      return row ? { eventId: row.event_id, at: row.at } : undefined;
    },
    setCursor(shard, eventId, at) {
      s.setCursor.run(shard, eventId, at);
    },
    ready() {
      const row = s.meta.get("ready") as { value: string } | undefined;
      return row ? Number(row.value) : undefined;
    },
    setReady(at) {
      s.setMeta.run("ready", String(at));
    },
    batch(fn) {
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
