import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageError } from "../../src/errors.js";
import {
  FARCASTER_EPOCH,
  farcasterNow,
  farcasterToDate,
  parseDuration,
} from "../../src/protocol/time.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2021-01-02T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("counts seconds from the Farcaster epoch 2021-01-01T00:00:00Z", () => {
  expect(farcasterNow()).toBe(86400);
});

it("agrees with @farcaster/core's epoch and time helpers", async () => {
  const hub = await import("@farcaster/core");
  expect(FARCASTER_EPOCH).toBe(hub.FARCASTER_EPOCH);
  vi.setSystemTime(new Date("2026-10-19T12:34:56.789Z"));
  expect(farcasterNow()).toBe(hub.getFarcasterTime()._unsafeUnwrap());
  expect(farcasterToDate(123456789).getTime()).toBe(
    hub.fromFarcasterTime(123456789)._unsafeUnwrap(),
  );
});

it("converts a Farcaster timestamp back to a Date", () => {
  expect(farcasterToDate(86400).toISOString()).toBe("2021-01-02T00:00:00.000Z");
});

it("parses durations in seconds, minutes, hours and days", () => {
  expect(parseDuration("45s")).toBe(45);
  expect(parseDuration("15m")).toBe(900);
  expect(parseDuration("24h")).toBe(86400);
  expect(parseDuration("30d")).toBe(2592000);
});

it("rejects durations it cannot read", () => {
  for (const bad of ["", "30", "d", "1w", "-1d", "1.5h"]) {
    expect(() => parseDuration(bad)).toThrow(UsageError);
  }
});
