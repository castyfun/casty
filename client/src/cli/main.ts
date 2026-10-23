import { Command, CommanderError } from "commander";
import { DEFAULT_NODE_URL } from "../config.js";
import { CastyError } from "../errors.js";
import { registerCast } from "./cast.js";
import { registerClients } from "./clients.js";
import type { Io } from "./context.js";
import { registerDoctor } from "./doctor.js";
import { registerFeed } from "./feed.js";
import { registerFollow } from "./follow.js";
import { registerInit } from "./init.js";
import { registerKey } from "./key.js";
import { registerMentions } from "./mentions.js";
import { registerNode } from "./node.js";
import { registerReact } from "./react.js";
import { registerServe } from "./serve.js";
import { registerStorage } from "./storage.js";
import { registerThread } from "./thread.js";
import { registerWeb } from "./web.js";
import { registerWhoami } from "./whoami.js";

const GROUPS: Record<string, string> = {
  doctor: "Set up:",
  init: "Set up:",
  whoami: "Set up:",
  key: "Set up:",
  feed: "Read:",
  mentions: "Read:",
  thread: "Read:",
  clients: "Read:",
  storage: "Read:",
  node: "Read:",
  web: "In a browser:",
  serve: "In a browser:",
};

const EXAMPLES = `
Examples:
  casty feed --since 24h --no-replies
  casty feed --exclude-app <name>     leave out casts posted through one app
  casty like 2                        the second cast of the last casty feed
  casty reply 2 "agreed"
  casty follow @name
  casty web                           the feed in your browser, or on your phone`;

function program(io: Io): Command {
  const casty = new Command("casty")
    .description("Read and write Farcaster through your own Snapchain node.")
    .option(
      "--node <url>",
      "node HTTP API; casty init remembers the one it is given",
      DEFAULT_NODE_URL,
    )
    .option("--json", "print results as JSON")
    .option("--config <dir>", "config directory (default: $XDG_CONFIG_HOME/casty)")
    .option("--quiet", "print results only, no progress notes")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
      getOutHelpWidth: () => io.stdout.columns ?? 80,
      getErrHelpWidth: () => io.stderr.columns ?? 80,
    });
  for (const register of [
    registerDoctor,
    registerInit,
    registerWhoami,
    registerKey,
    registerFeed,
    registerMentions,
    registerThread,
    registerCast,
    registerReact,
    registerFollow,
    registerClients,
    registerStorage,
    registerNode,
    registerWeb,
    registerServe,
  ]) {
    register(casty, io);
  }
  for (const command of casty.commands) command.helpGroup(GROUPS[command.name()] ?? "Write:");
  return casty.addHelpText("after", EXAMPLES);
}

/** Runs the CLI and returns its exit code: 0 ok, 1 generic, 2 usage, 3 rejected, 4 unreachable, 5 config. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    await program(io).parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`casty: ${message}\n`);
    if (error instanceof CastyError) {
      if (error.hint) io.stderr.write(`hint: ${error.hint}\n`);
      return error.exitCode;
    }
    return 1;
  }
}
