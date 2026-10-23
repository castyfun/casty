#!/usr/bin/env node
// Fails when a docs page no longer shows the current --help output of the command it documents.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const PAGES = [
  ["index.mdx", ["scripts/deploy.sh", "--help"]],
  ["0-provision.mdx", ["scripts/0-provision.sh", "--help"]],
  ["1-node.mdx", ["scripts/1-node.sh", "--help"]],
  ["2-client.mdx", ["scripts/2-client.sh", "--help"]],
  ["2-client.mdx", ["node_modules/.bin/tsx", "client/src/cli/index.ts", "--help"]],
  ["web.mdx", ["node_modules/.bin/tsx", "client/src/cli/index.ts", "web", "--help"]],
  ["serve.mdx", ["node_modules/.bin/tsx", "client/src/cli/index.ts", "serve", "--help"]],
];

let stale = 0;
for (const [page, [command, ...args]] of PAGES) {
  const help = execFileSync(join(ROOT, command), args, { cwd: ROOT, encoding: "utf8" }).trimEnd();
  if (!readFileSync(join(ROOT, "docs/src/content/docs", page), "utf8").includes(help)) {
    console.error(
      `docs/src/content/docs/${page} does not show the current output of ${command} ${args.join(" ")}`,
    );
    stale++;
  }
}
process.exitCode = stale > 0 ? 1 : 0;
