import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

export default defineConfig({ test: { testTimeout } })
