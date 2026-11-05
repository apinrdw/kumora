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
      // Decision: keep prerendering `/` under alchemy, whose prerender server
      // runs the SSR bundle in Bun without bindings. So no module prerender
      // reaches may import `cloudflare:workers` at top level; the bridge in
      // packages/server reaches it per request. Fallback: alchemy's runtime
      // plugin in this file, for preview only. See apinrdw/kumora#23.
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
