import { defineConfig } from "vitest/config"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
export default defineConfig({
  resolve: { tsconfigPaths: true },
})
