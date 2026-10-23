import { UsageError } from "../errors.js";

/**
 * 2021-01-01T00:00:00Z in unix milliseconds. @farcaster/core exports the same constant, and its time
 * helpers are this arithmetic (test/protocol/time.test.ts compares them); keeping them here
 * spares every command the load of the whole library.
 */
export const FARCASTER_EPOCH = 1_609_459_200_000;

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** Seconds since 2021-01-01T00:00:00Z, the unit of every Farcaster message timestamp. */
export function farcasterNow(): number {
  return Math.round((Date.now() - FARCASTER_EPOCH) / 1000);
}

export function farcasterToDate(timestamp: number): Date {
  return new Date(timestamp * 1000 + FARCASTER_EPOCH);
}

/** Parses "45s", "15m", "24h" or "30d" into seconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text);
  if (!match) {
    throw new UsageError(
      `cannot read the duration "${text}"`,
      "write a number and s, m, h or d, e.g. 30d",
    );
  }
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}

/** The protocol lets a message run this far ahead of the clock, and no further. */
const MAX_SKEW_SECONDS = 600;

/**
 * Whether a message's timestamp is at most ten minutes ahead of now. Older nodes let through
 * casts dated decades ahead (one from 2061 sits on mainnet); sorted by time, those would top a
 * feed for good, so the feed and the index leave them out.
 */
export function timely(message: { data: { timestamp: number } }): boolean {
  return message.data.timestamp <= farcasterNow() + MAX_SKEW_SECONDS;
}
