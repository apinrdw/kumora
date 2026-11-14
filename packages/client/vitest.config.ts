import { defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout"

export default defineConfig({ test: { testTimeout } })
