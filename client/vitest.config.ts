import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**"],
      // A little under what the tests reach, so a change that drops coverage noticeably fails CI.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
  },
});
