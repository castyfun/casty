import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "@casty/mock-node";

/** The generator's source, so a change to it is never answered with fixtures it made before. */
const GENERATOR = createHash("sha256")
  .update(readFileSync(join(import.meta.dirname, "../../../test/mock-node/src/fixtures.ts")))
  .digest("hex")
  .slice(0, 12);

/**
 * generateFixtures signs every cast, about 5 s for 15000 of them; the output depends only on the
 * arguments and the generator, so it is kept in the temp directory between runs.
 */
export async function cachedFixtures(
  options: Parameters<typeof generateFixtures>[0],
): ReturnType<typeof generateFixtures> {
  const file = join(
    tmpdir(),
    `casty-fixtures-${GENERATOR}-${options.fids}-${options.casts}-${options.seed}.json`,
  );
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const fixtures = await generateFixtures(options);
  // Whole or not at all: another test worker may be reading the file as it lands.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(fixtures));
  renameSync(temp, file);
  return fixtures;
}

/** mulberry32: the same seed gives the same cases on every run. */
export function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
