import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateFixtures, writeFixtures } from "./fixtures.js";
import { createMockNode } from "./server.js";

const USAGE = `usage:
  mock-snapchain serve [--port 3381] [--fixtures basic|<dir>]
  mock-snapchain gen [--fids 12] [--casts 4] [--seed 42] [--out <dir>]`;

const [command = "serve", ...args] = process.argv.slice(2);

if (command === "serve") {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: "3381" },
      fixtures: { type: "string", default: "basic" },
    },
  });
  const node = await createMockNode({ port: Number(values.port), fixtures: values.fixtures });
  console.log(`mock-snapchain listening on ${node.url} (fixtures: ${values.fixtures})`);
  const stop = () => void node.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else if (command === "gen") {
  const { values } = parseArgs({
    args,
    options: {
      fids: { type: "string", default: "12" },
      casts: { type: "string", default: "4" },
      seed: { type: "string", default: "42" },
      out: { type: "string", default: join(import.meta.dirname, "../fixtures/generated") },
    },
  });
  const options = {
    fids: Number(values.fids),
    casts: Number(values.casts),
    seed: Number(values.seed),
  };
  writeFixtures(values.out, await generateFixtures(options));
  console.log(
    `wrote ${options.fids} authors x ${options.casts} casts (seed ${options.seed}) to ${values.out}`,
  );
} else {
  console.error(USAGE);
  process.exit(2);
}
