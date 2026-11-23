import { parseStage, stageUrl } from "@workspace/deploy"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { Effect } from "effect"
import { defineConfig, type Plugin } from "vite"

import { manifest, optionsPage, scriptEntries } from "./manifest.ts"

// Production's dashboard, the target the relay always sends to.
const productionDashboard = Effect.runSync(
  Effect.orDie(
    Effect.flatMap(parseStage("production"), (stage) =>
      stageUrl("dashboard", stage)
    )
  )
)

// Writes dist/manifest.json from manifest.ts.
const manifestPlugin = (): Plugin => ({
  name: "kumora-extension-manifest",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "manifest.json",
      source: JSON.stringify(manifest(productionDashboard), null, 2),
    })
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), manifestPlugin()],
  define: {
    __PRODUCTION_DASHBOARD__: JSON.stringify(productionDashboard),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No minifying. The owner loads dist unpacked and reads its
    // stack traces in chrome://extensions.
    minify: false,
    rolldownOptions: {
      input: { ...scriptEntries, options: optionsPage },
      output: {
        // The manifest names the scripts, so their names carry no hash.
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
})
