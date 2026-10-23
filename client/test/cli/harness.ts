import { Readable } from "node:stream";
import { TEST_MNEMONIC } from "@casty/mock-node";
import { run } from "../../src/cli/main.js";
import { tempDir } from "../tmp.js";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Pretend stdin and stdout are a terminal. */
  tty?: boolean;
  /** Stands in for the hidden terminal prompt; without it, anything that would prompt fails. */
  prompt?: (question: string) => Promise<Uint8Array>;
  /** Stops a command that keeps running, such as casty web. */
  until?: Promise<unknown>;
  /** Sees stdout as it is written. */
  onStdout?: (text: string) => void;
  /** Sees stderr as it is written. */
  onStderr?: (text: string) => void;
}

/** Runs the CLI in-process, with short confirmation timeouts against the mock. */
export async function casty(args: string[], options: RunOptions = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const input = Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]);
  const io = {
    stdin: Object.assign(input, { isTTY: options.tty }),
    stdout: {
      write: (s: string) => {
        stdout += s;
        options.onStdout?.(s);
      },
      isTTY: options.tty,
    },
    stderr: {
      write: (s: string) => {
        stderr += s;
        options.onStderr?.(s);
      },
    },
    env: options.env ?? {},
    // 30 polls before a resend: the mock merges at once unless a test delays it.
    confirm: { timeoutMs: 300, pollMs: 10 },
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.until ? { until: options.until } : {}),
  };
  const code = await run(["node", "casty", ...args], io);
  return { code, stdout, stderr };
}

export const tempConfig = () => tempDir("casty-cli-");

/** `casty init` for fid 1 against `nodeUrl`, with the test mnemonic and passphrase. */
export async function initMe(nodeUrl: string, dir: string, extra: string[] = []): Promise<Result> {
  const args = ["init", "--mnemonic-stdin", "--json", "--node", nodeUrl, "--config", dir, ...extra];
  return casty(args, { stdin: `${TEST_MNEMONIC}\n`, env: { CASTY_PASSPHRASE: "x" } });
}

/** Global flags for a command run against the mock with the test passphrase. */
export const flags = (nodeUrl: string, dir: string) => ["--node", nodeUrl, "--config", dir];
export const PASS = { CASTY_PASSPHRASE: "x" };
