import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { testTimeout },
})
