import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// Tests run in Node without vite.config.ts's build plugins.
export default defineConfig({ test: { testTimeout } })
