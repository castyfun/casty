import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { ConfigError, UsageError } from "../errors.js";

/** First line of a stream, as bytes. Every intermediate buffer is zeroed. */
export async function readFirstLine(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
    if (typeof chunk !== "string") (chunk as Buffer).fill(0);
  }
  const all = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  const end = all.indexOf(10);
  const line = new Uint8Array(all.subarray(0, end < 0 ? all.length : end));
  all.fill(0);
  return line;
}

function terminal(): ReadStream {
  if (process.stdin.isTTY) return process.stdin as ReadStream;
  try {
    return new ReadStream(openSync("/dev/tty", "r"));
  } catch {
    throw new ConfigError("there is no terminal to ask on", "run casty in a terminal");
  }
}

/**
 * Reads one line from the terminal with echo off. Uses /dev/tty when stdin is a pipe, so
 * `--mnemonic-stdin` can still be followed by a passphrase prompt.
 */
export async function promptHidden(question: string): Promise<Uint8Array> {
  const input = terminal();
  const buffer = new Uint8Array(1024);
  let length = 0;
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      input.on("data", (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) reject(new UsageError("cancelled"));
          else if (byte === 13 || byte === 10) resolve(buffer.slice(0, length));
          else if (byte === 127 || byte === 8) length = Math.max(0, length - 1);
          else if (length < buffer.length) buffer[length++] = byte;
        }
        chunk.fill(0);
      });
    });
  } finally {
    buffer.fill(0);
    input.removeAllListeners("data");
    input.setRawMode(false);
    input.pause();
    if (input !== process.stdin) input.destroy();
    process.stderr.write("\n");
  }
}
