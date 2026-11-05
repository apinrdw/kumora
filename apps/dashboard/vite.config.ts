import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Crawl every route up front: deps reached only from lazily loaded routes are
  // otherwise discovered mid-session in dev, which force-reloads the page.
  optimizeDeps: { entries: ["src/routes/**/*.tsx"] },
  plugins: [
    // The OS picks the port. The default probes 9229 and binds it later, so apps
    // started together race for it and one dies with EADDRINUSE.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: 0,
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
