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
import { StageUrl } from "@workspace/deploy/stage-url"
import { Effect, Option, Schema } from "effect"

// Cloudflare's own paths on every host, such as `alchemy dev`'s local R2
// endpoint (apps/e2e/support/archive-bucket.ts). The dev server
// (vite.config.ts) passes them through too.
export const CLOUDFLARE_PATH = "/cdn-cgi/"

// The bindings the entry's redirects read, as Cloudflare hands them to
// `fetch`, not through `WorkerEnv`: vite.config.ts loads this file, and
// pulling `@workspace/server` into the dev server broke Market Live's sockets
// in e2e.
export interface RedirectEnv {
  readonly DASHBOARD_URL: string
  readonly REDIRECT_TO_STAGE_URL?: "on"
}

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
//
// A DASHBOARD_URL that isn't a Stage URL is a broken deploy, so a defect.
const redirectToStageUrl = Effect.fnUntraced(function* (
  request: Request,
  env: RedirectEnv
) {
  if (env.REDIRECT_TO_STAGE_URL === undefined) return Option.none()
  const url = new URL(request.url)
  const stage = new URL(
    yield* Schema.decodeUnknownEffect(StageUrl)(env.DASHBOARD_URL).pipe(
      Effect.orDie
    )
  )
  if (url.host === stage.host) return Option.none()
  const path = yield* underBase(url.pathname)
  return Option.some(
    Response.redirect(`${stage.origin}${path}${url.search}`, 301)
  )
})

export const entryRedirect = Effect.fnUntraced(function* (
  request: Request,
  env: RedirectEnv
) {
  const toStage = yield* redirectToStageUrl(request, env)
  return Option.isSome(toStage) ? toStage : yield* redirectIntoBase(request)
})
