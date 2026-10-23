// Builds casty as one file with bun: the client, its dependencies and the web page, embedded as
// `assets/` next to the code, where server.ts looks for it. `node binary.mjs` builds for this
// machine into release/casty; `node binary.mjs bun-linux-x64` cross-compiles into
// release/casty-linux-x64, the name the releases use. Not dist/, which build.mjs empties.
// Beside it, THIRD_PARTY_LICENSES: the packages inside the file keep their licenses, which ask
// to travel with every copy.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The paths below are the client's, whichever directory this is run from.
process.chdir(import.meta.dirname);
const target = process.argv[2];
const out = target ? `release/casty-${target.replace(/^bun-/, "")}` : "release/casty";
const flags = ["--compile", "--asset=src/web/assets", ...(target ? [`--target=${target}`] : [])];
execFileSync("bun", ["build", ...flags, "--outfile", out, "src/cli/index.ts"], {
  stdio: "inherit",
});
console.log(`${out}: ${(statSync(out).size / 1e6).toFixed(1)} MB`);

// Every package the client depends on at runtime, as pnpm lists them (a build tool among them
// does no harm), each with its license file, or its package.json's license where it ships none.
const listed = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--filter", "@casty/client"], {
    encoding: "utf8",
  }),
);
const packages = Object.entries(listed)
  .flatMap(([license, entries]) => entries.map((entry) => ({ ...entry, license })))
  .sort((a, b) => a.name.localeCompare(b.name));
const notice = (entry) => {
  const dir = entry.paths[0];
  const file = readdirSync(dir).find((name) => /^licen[cs]e/i.test(name));
  const text = file
    ? readFileSync(join(dir, file), "utf8").trim()
    : `The package ships no license file; its package.json names the license ${entry.license}.`;
  return `${entry.name} ${entry.versions.join(", ")} (${entry.license})\n${"-".repeat(72)}\n${text}\n`;
};
writeFileSync(
  "release/THIRD_PARTY_LICENSES",
  "casty is built as one file with the packages below inside it. Each keeps its own license,\n" +
    `reproduced here from the file it ships, or named from its package.json where it ships none.\n\n${packages.map(notice).join("\n")}`,
);
console.log(`release/THIRD_PARTY_LICENSES: ${packages.length} packages`);
