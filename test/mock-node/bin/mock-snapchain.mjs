#!/usr/bin/env node
// Runs the TypeScript sources directly; the mock is test tooling and is never built.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
