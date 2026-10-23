import assert from "node:assert/strict";
import { test } from "node:test";
import { lint, lintTree } from "./prose-lint.mjs";

const BANNED = ["seamlessly", "Let's dive"];
const messages = (text) => lint(text, BANNED).map((f) => `${f.line}: ${f.message}`);
const page = (body, frontmatter = "title: T") => `---\n${frontmatter}\n---\n\n${body}\n`;

test("flags banned phrases in any case, but not inside code", () => {
  assert.deepEqual(messages(page("It works SEAMLESSLY.\n\n`seamlessly` in code is fine.")), [
    '5: banned phrase "seamlessly"',
  ]);
  assert.deepEqual(messages(page("```sh\nlet's dive\n```")), []);
});

test("flags emoji anywhere", () => {
  assert.deepEqual(messages(page("## Done \u{1F680}\n\ntext")), ["5: emoji"]);
});

test("flags a heading with nothing under it", () => {
  assert.deepEqual(messages(page("## One\n\n## Two\n\ntext")), [
    "5: heading with an empty section",
  ]);
  assert.deepEqual(messages(page("text\n\n## Last")), ["7: heading with an empty section"]);
});

test("a subsection or a code block counts as content", () => {
  assert.deepEqual(messages(page("## One\n\n### Sub\n\ntext\n\n## Two\n\n```sh\nls\n```")), []);
});

test("a comment alone is no content, unless the page is a draft", () => {
  const body = "## Soon\n\n{/* to be written */}";
  assert.deepEqual(messages(page(body)), ["5: heading with an empty section"]);
  assert.deepEqual(messages(page(body, "title: T\ndraft: true")), []);
});

test("flags an empty page that is not a draft", () => {
  assert.deepEqual(messages(page("{/* TODO */}")), ["1: page has no content"]);
  assert.deepEqual(messages(page("{/* TODO */}", "title: T\ndraft: true")), []);
});

test("allows one exclamation mark per page, not counting images and code", () => {
  assert.deepEqual(messages(page("Done!\n\n![diagram](d.png)\n\n`a != b`")), []);
  assert.deepEqual(messages(page("Done!\n\nAgain!")), [
    "7: more than one exclamation mark on the page",
  ]);
});

test("the docs in this repository pass", () => {
  assert.deepEqual(lintTree(), []);
});
