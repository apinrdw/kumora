import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      // Decision: only the bridge and workflow.ts import cloudflare:workers
      // (packages/server/docs/adr/0001-only-the-bridge-and-the-workflow-runner-import-cloudflare-workers.md)
      prerender: {
        enabled: true,
        crawlLinks: true,
        // The probe reads a runtime secret, so it must never be prerendered.
        filter: (page) => !page.path.startsWith("/probe"),
      },
    }),
    viteReact(),
  ],
})

export default config
