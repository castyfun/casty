#!/usr/bin/env node
import { run } from "./main.js";
import { promptHidden } from "./prompt.js";

const io = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  prompt: promptHidden,
};
process.exitCode = await run(process.argv, io);
