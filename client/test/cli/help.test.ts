import { expect, it } from "vitest";
import { casty } from "./harness.js";

const COMMANDS = [
  [],
  ["doctor"],
  ["init"],
  ["whoami"],
  ["key"],
  ["key", "list"],
  ["key", "revoke"],
  ["feed"],
  ["mentions"],
  ["thread"],
  ["cast"],
  ["reply"],
  ["like"],
  ["unlike"],
  ["recast"],
  ["unrecast"],
  ["follow"],
  ["unfollow"],
  ["delete"],
  ["clients"],
  ["storage"],
  ["node"],
  ["node", "status"],
  ["web"],
];

it.each(COMMANDS.map((c) => [c.join(" ") || "casty", c]))("help for %s", async (_, command) => {
  const { code, stdout } = await casty([...command, "--help"]);
  expect(code).toBe(0);
  expect(stdout).toMatchSnapshot();
});

it("groups the commands by what they are for and ends with examples", async () => {
  const { stdout } = await casty(["--help"]);
  expect(stdout).toMatch(/\nSet up:\n {2}doctor/);
  expect(stdout).toMatch(/\nRead:\n {2}feed/);
  expect(stdout).toMatch(/\nWrite:\n {2}cast/);
  expect(stdout).toMatch(/\nExamples:\n/);
  expect(stdout.trimEnd()).toMatch(/casty \w.*$/);
});
