import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
// Vite transforms JSX on its own, so the suites need only the path aliases.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Report fixtures load as base64 data URLs (`?inline`): lint keeps node:fs
  // out of tests.
  assetsInclude: ["**/*.xlsx", "**/*.zip"],
  test: {
    // Decision: two workers, isolation kept on. Vitest's default on CI's
    // 2 vCPU is one worker, which ran the files one at a time. Turning
    // isolation off saves 18 s but leaks happy-dom documents between files
    // (#171).
    maxWorkers: 2,
    testTimeout,
  },
})
