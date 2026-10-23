#!/usr/bin/env node
// Keeps the prose honest: banned phrases, emoji, headings with nothing under them, and more than
// one exclamation mark per page. Pages with `draft: true` may still have empty sections.
// Usage: node docs/tools/prose-lint.mjs   (checks docs/src/content/docs, README.md and SECURITY.md)
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "../..");
const DOCS = join(ROOT, "docs/src/content/docs");
const EMOJI = /\p{Extended_Pictographic}/u;
const HEADING = /^(#{1,6})\s/;

export function loadBanned(path = join(import.meta.dirname, "banned-phrases.txt")) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * The page with everything that is not prose blanked out, keeping line numbers: frontmatter,
 * code (fence lines stay, so a code block still counts as content), inline code, comments.
 */
function prose(lines) {
  let inFrontmatter = lines[0] === "---";
  let inFence = false;
  return lines.map((line, i) => {
    if (inFrontmatter) {
      if (i > 0 && line === "---") inFrontmatter = false;
      return "";
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "```";
    }
    if (inFence) return "";
    return line
      .replace(/`[^`]*`/g, "")
      .replace(/\{\/\*.*?\*\/\}/g, "")
      .replace(/<!--.*?-->/g, "");
  });
}

/** Findings for one page, as { line, message } with 1-based lines. */
export function lint(text, banned) {
  const raw = text.split("\n");
  const lines = prose(raw);
  const draft = /^---\n[\s\S]*?^draft:\s*true\s*$[\s\S]*?^---$/m.test(text);
  const findings = [];
  const add = (index, message) => findings.push({ line: index + 1, message });

  raw.forEach((line, i) => {
    if (EMOJI.test(line)) add(i, "emoji");
  });
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const phrase of banned) {
      if (lower.includes(phrase.toLowerCase())) add(i, `banned phrase "${phrase}"`);
    }
  });

  let exclamations = 0;
  lines.forEach((line, i) => {
    for (const _ of line.matchAll(/!(?![[=])/g)) {
      if (++exclamations === 2) add(i, "more than one exclamation mark on the page");
    }
  });

  if (!draft) {
    if (lines.every((line) => line.trim() === "")) add(0, "page has no content");
    lines.forEach((line, i) => {
      const heading = HEADING.exec(line);
      if (heading && sectionIsEmpty(lines, i, heading[1].length))
        add(i, "heading with an empty section");
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** True when nothing but blank lines follows the heading before a heading of its level or above. */
function sectionIsEmpty(lines, index, level) {
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "") continue;
    const next = HEADING.exec(line);
    return Boolean(next && next[1].length <= level);
  }
  return true;
}

function pages(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => join(dir, file));
}

/** Findings for every docs page and the README, as "path:line: message". */
export function lintTree() {
  const banned = loadBanned();
  return [...pages(DOCS), join(ROOT, "README.md"), join(ROOT, "SECURITY.md")].flatMap((file) =>
    lint(readFileSync(file, "utf8"), banned).map(
      (f) => `${relative(ROOT, file)}:${f.line}: ${f.message}`,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = lintTree();
  for (const finding of findings) console.error(finding);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
