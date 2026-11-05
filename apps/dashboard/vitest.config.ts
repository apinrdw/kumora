import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Vitest would otherwise load vite.config.ts, whose Cloudflare plugin fails to
// start its Worker runner under Vitest. Tests run in Node without it; Vite
// transforms JSX on its own, so the suites need only the path aliases.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("tests/support/cloudflare-workers.ts", import.meta.url)
      ),
      "@tanstack/react-start/server-entry": fileURLToPath(
        new URL("tests/support/start-entry.ts", import.meta.url)
      ),
    },
  },
})
