import { defineConfig, type Plugin } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { DashboardBasePath } from "@workspace/client"
import { Effect, Option } from "effect"

import { redirectIntoBase } from "./src/server/base-redirect.ts"

// Cloudflare's own paths, such as `alchemy dev`'s local R2 endpoint
// (apps/e2e/support/archive-bucket.ts), which the local runtime serves.
const CLOUDFLARE_PATH = "/cdn-cgi/"

// The Worker entry's redirect into the base path, on the dev server too: Vite
// answers a path outside `base` itself, before the Worker sees it, and so it
// does the base path with no trailing slash, which the router serves.
// Cloudflare's own paths get the base put in front, which Vite's base check
// strips again, so they reach the local runtime unchanged.
const redirectIntoBaseInDev: Plugin = {
  name: "kumora:redirect-into-base",
  apply: "serve",
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      const url = request.url ?? "/"
      if (url.startsWith(CLOUDFLARE_PATH)) {
        request.url = `${DashboardBasePath}${url}`
        return next()
      }
      if (
        url === DashboardBasePath ||
        url.startsWith(`${DashboardBasePath}?`)
      ) {
        request.url = `${DashboardBasePath}/${url.slice(DashboardBasePath.length)}`
        return next()
      }
      const redirect = Effect.runSync(
        redirectIntoBase(
          new Request(`http://${request.headers.host}${request.url ?? "/"}`)
        )
      )
      if (Option.isNone(redirect)) return next()
      response.writeHead(redirect.value.status, {
        location: redirect.value.headers.get("location") ?? DashboardBasePath,
      })
      response.end()
    })
  },
}

const config = defineConfig({
  // TanStack Start takes the router's basepath from it; every path that skips
  // the router joins DashboardBasePath itself (packages/client/src/base-path.ts).
  // Decision: the dashboard is served under /dashboard on every Stage
  // (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
  base: `${DashboardBasePath}/`,
  resolve: { tsconfigPaths: true },
  // Crawl every route up front: deps reached only from lazily loaded routes are
  // otherwise discovered mid-session in dev, which force-reloads the page.
  optimizeDeps: { entries: ["src/routes/**/*.tsx"] },
  plugins: [
    redirectIntoBaseInDev,
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
