// A request on the dashboard's own host for a path outside the dashboard base
// path: a 301 to the same path, query kept, under it. An old bookmark and the
// host's root then still open the dashboard. The Worker entry (src/worker.ts)
// answers it before Market Live and TanStack Start, and the dev server
// (vite.config.ts) before Vite's own base check, which would answer 404.
import { DashboardBasePath, pathUnderBase } from "@workspace/client/base-path"
import { Effect, Option } from "effect"

// Cloudflare's own paths on every host, such as `alchemy dev`'s local R2
// endpoint (apps/e2e/support/archive-bucket.ts). The dev server
// (vite.config.ts) passes them through too.
export const CLOUDFLARE_PATH = "/cdn-cgi/"

// Decision: the dashboard is served under /dashboard on every Stage
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
export const redirectIntoBase = Effect.fnUntraced(function* (request: Request) {
  const url = new URL(request.url)
  if (url.pathname.startsWith(CLOUDFLARE_PATH)) return Option.none()
  if (Option.isSome(yield* pathUnderBase(url.pathname))) return Option.none()
  url.pathname = `${DashboardBasePath}${url.pathname}`
  return Option.some(Response.redirect(url.href, 301))
})
