import { defineConfig } from "vitest/config"

// The Playwright specs under tests/ are not Vitest's; only the support
// modules' own tests are.
export default defineConfig({ test: { include: ["support/**/*.test.ts"] } })
