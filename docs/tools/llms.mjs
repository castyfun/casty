#!/usr/bin/env node
// Writes the site's llms.txt (the repository's own, copied) and llms-full.txt (every English page
// as plain Markdown, in sidebar order) into docs/public, so an agent reads the docs in one fetch.
// Run by the docs build; both outputs are generated, not committed.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const DOCS = join(ROOT, "docs/src/content/docs");
const PUBLIC = join(ROOT, "docs/public");
const SITE = "https://castyfun.github.io/casty/";
const PAGES = [
  "index",
  "guide",
  "commands",
  "agents",
  "0-provision",
  "1-node",
  "2-client",
  "web",
  "serve",
  "home-node",
  "concepts/fids",
  "concepts/custody-and-app-keys",
  "concepts/read-nodes-vs-validators",
  "concepts/snapchain-messages",
  "concepts/storage-rent",
  "concepts/wallets",
  "security",
  "troubleshooting",
  "versions",
];

/** A page as plain Markdown: its title as a heading, no frontmatter, imports, components or comments. */
export function plain(source, slug) {
  const [, front = "", body = source] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source) ?? [];
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(front)?.[1] ?? slug;
  const url = SITE + (slug === "index" ? "" : `${slug}/`);
  const text = body
    .replace(/^import .*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^<[A-Z][\s\S]*?\/>$/gm, "")
    .replace(/^<\/?div[^>]*>$/gm, "")
    .replace(/\]\((\.\.\/)*([a-z0-9-]+\/[^)]*)\)/g, (_, _up, path) => `](${SITE}${path})`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `# ${title}\n\nSource: ${url}\n\n${text}\n`;
}

// The prompt is shown twice, in llms.txt and on the agents page; they must not drift apart.
const prompt = (text) => /```text\n([\s\S]*?)```/.exec(text)?.[1];
const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");
if (!prompt(llms) || prompt(llms) !== prompt(readFileSync(join(DOCS, "agents.mdx"), "utf8"))) {
  console.error("llms.txt and docs/src/content/docs/agents.mdx show different prompts");
  process.exit(1);
}
copyFileSync(join(ROOT, "llms.txt"), join(PUBLIC, "llms.txt"));
const full = PAGES.map((slug) => plain(readFileSync(join(DOCS, `${slug}.mdx`), "utf8"), slug));
writeFileSync(join(PUBLIC, "llms-full.txt"), full.join("\n---\n\n"));
console.log(`wrote docs/public/llms.txt and docs/public/llms-full.txt (${PAGES.length} pages)`);
