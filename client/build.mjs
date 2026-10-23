// Builds dist/: casty.js bundles the client's own code and leaves its dependencies to
// node_modules; what only some commands need (signing, the web server) is split into chunks
// loaded on first use, and casty web's page is copied next to them, where server.ts looks.
import { cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: { casty: "src/cli/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
cpSync("src/web/assets", "dist/assets", { recursive: true });
