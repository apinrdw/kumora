import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// The Playwright specs under tests/ are not Vitest's; only the support
// modules' own tests are.
export default defineConfig({
  test: { include: ["support/**/*.test.ts"], testTimeout },
})
