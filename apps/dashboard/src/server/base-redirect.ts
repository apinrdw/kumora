// The Worker entry's redirects (src/worker.ts), answered before Market Live
// and TanStack Start.
//
// - Into the base path: a request on the dashboard's own host for a path
//   outside the dashboard base path gets a 301 to the same path, query kept,
//   under it. An old bookmark and the host's root then still open the
//   dashboard. The dev server (vite.config.ts) runs it too, before Vite's own
//   base check, which would answer 404.
// - To the Stage URL, on Production only: any other host, its old workers.dev
//   URL among them, gets a 301 to the Stage URL's host, the path joined under
//   the base path and the query kept.
import { DashboardBasePath, pathUnderBase } from "@workspace/client/base-path"
import { WorkerEnv } from "@workspace/server"
import { Effect, Option } from "effect"

import { dashboardStageUrl } from "./dashboard-url.ts"

// Cloudflare's own paths on every host, such as `alchemy dev`'s local R2
// endpoint (apps/e2e/support/archive-bucket.ts). The dev server
// (vite.config.ts) passes them through too.
export const CLOUDFLARE_PATH = "/cdn-cgi/"

const underBase = Effect.fnUntraced(function* (pathname: string) {
  return Option.isSome(yield* pathUnderBase(pathname))
    ? pathname
    : `${DashboardBasePath}${pathname}`
})

// Decision: the dashboard is served under /dashboard on every Stage
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
export const redirectIntoBase = Effect.fnUntraced(function* (request: Request) {
  const url = new URL(request.url)
  if (url.pathname.startsWith(CLOUDFLARE_PATH)) return Option.none()
  if (Option.isSome(yield* pathUnderBase(url.pathname))) return Option.none()
  url.pathname = yield* underBase(url.pathname)
  return Option.some(Response.redirect(url.href, 301))
})

// Decision: Production alone redirects other hosts to its Stage URL
// (apps/dashboard/docs/adr/0135-production-alone-redirects-other-hosts-to-its-stage-url.md)
const redirectToStageUrl = Effect.fnUntraced(function* (request: Request) {
  if ((yield* WorkerEnv).REDIRECT_TO_STAGE_URL === undefined)
    return Option.none()
  const url = new URL(request.url)
  const stage = new URL(yield* dashboardStageUrl)
  if (url.host === stage.host) return Option.none()
  const path = yield* underBase(url.pathname)
  return Option.some(
    Response.redirect(`${stage.origin}${path}${url.search}`, 301)
  )
})

export const entryRedirect = Effect.fnUntraced(function* (request: Request) {
  const toStage = yield* redirectToStageUrl(request)
  return Option.isSome(toStage) ? toStage : yield* redirectIntoBase(request)
})
