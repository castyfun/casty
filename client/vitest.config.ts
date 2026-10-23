import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Many tests start a mock node and a casty process; a 2-core CI runner running every suite
    // side by side needs more than the default 5 s for some of them.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**"],
      // A little under what the tests reach, so a change that drops coverage noticeably fails CI.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
  },
});
