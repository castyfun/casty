import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

// Importing @farcaster/core takes a third of a second or more, and viem over a tenth, so
// the CLI loads them only inside the commands that build or sign messages. This walks the static
// imports (`import ... from`, not `await import()`) from the entry point and fails if one of them
// reaches either library, naming the chain of files that does.
const SRC = join(import.meta.dirname, "../../src");
const HEAVY = ["@farcaster/core", "viem"];
// `import x from "m";`, `export { y } from "m";` and the bare `import "m";`, not `import type`.
const STATIC_IMPORT = /^(?:import|export)\s+(?!type\s)(?:[^;]*?\sfrom\s+)?"([^"]+)";/gms;

function staticImports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  return [...code.matchAll(STATIC_IMPORT)].map((m) => m[1] as string);
}

function heavyChain(entry: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    for (const spec of staticImports(file)) {
      if (HEAVY.some((h) => spec === h || spec.startsWith(`${h}/`))) return [...chain, spec];
      if (!spec.startsWith(".")) continue;
      const next = join(dirname(file), spec.replace(/\.js$/, ".ts"));
      const found = walk(next, [...chain, relative(SRC, next)]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(entry, [relative(SRC, entry)]);
}

it("starts without loading the Farcaster library or viem", () => {
  expect(heavyChain(join(SRC, "cli/index.ts"))).toBeUndefined();
});
