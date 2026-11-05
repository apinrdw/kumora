import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
// The bridge's per-request `cloudflare:workers` import resolves to a stub that
// a suite fills with the bindings it needs.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("tests/support/cloudflare-workers.ts", import.meta.url)
      ),
    },
  },
})
