import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { DashboardBasePath } from "@workspace/client"

const config = defineConfig({
  // TanStack Start takes the router's basepath from it; every path that skips
  // the router joins DashboardBasePath itself (packages/client/src/base-path.ts).
  base: `${DashboardBasePath}/`,
  resolve: { tsconfigPaths: true },
  // Crawl every route up front: deps reached only from lazily loaded routes are
  // otherwise discovered mid-session in dev, which force-reloads the page.
  optimizeDeps: { entries: ["src/routes/**/*.tsx"] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
