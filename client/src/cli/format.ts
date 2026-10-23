import { InvalidArgumentError } from "commander";
import type { RenderOptions } from "../feed/render.js";
import type { Io } from "./context.js";

/** Left-aligned columns separated by two spaces. */
export function table(rows: string[][]): string {
  const widths = (rows[0] ?? []).map((_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

export const shortKey = (key: string) => `${key.slice(0, 10)}..${key.slice(-4)}`;

export function wholeNumber(text: string): number {
  if (!/^\d+$/.test(text)) throw new InvalidArgumentError("expected a whole number");
  return Number(text);
}

/** A count or a fid: 0 means nothing, so it is a typo. */
export function aboveZero(text: string): number {
  const n = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("expected a whole number above 0");
  }
  return n;
}

/** Accounts separated by commas, each a fid or an @name; the names are looked up later. */
export function accountList(text: string): (number | string)[] {
  return text.split(",").map((part) => {
    const item = part.trim();
    if (/^\d+$/.test(item)) return aboveZero(item);
    if (/^@?[^\s@]+$/.test(item)) return item.replace(/^@/, "");
    throw new InvalidArgumentError("expected fids and @names separated by commas, e.g. 2,@alice");
  });
}

export const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Wrapped to the terminal, and coloured only on one, unless NO_COLOR or TERM=dumb. */
export function feedStyle(io: Io): RenderOptions {
  const color = Boolean(io.stdout.isTTY) && !io.env.NO_COLOR && io.env.TERM !== "dumb";
  return { width: io.stdout.columns ?? 80, color };
}
