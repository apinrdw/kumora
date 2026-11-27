import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Crawl every route up front: deps reached only from lazily loaded routes are
  // otherwise discovered mid-session in dev, which force-reloads the page. A
  // web worker is reached only through `new URL`, so its file is crawled too.
  optimizeDeps: { entries: ["src/routes/**/*.tsx", "src/**/*.worker.ts"] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
