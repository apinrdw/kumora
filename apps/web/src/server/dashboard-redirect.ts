import { DashboardBasePath } from "@workspace/client/base-path"
import { Effect, Option } from "effect"

// A request for the dashboard's bare base path gets a 301 to the base path
// with its trailing slash, query kept, which the dashboard's `/dashboard/*`
// route takes. On Production the bare path reaches web only with a query:
// Cloudflare matches a zone route against the whole URL, so `/dashboard?x`
// misses the dashboard's exact `/dashboard` route, and no pattern may name a
// query or end in a bare `/dashboard*`, which would take `/dashboards-guide`.
// Decision: Production is served through zone routes on a proxied AAAA record
// (packages/deploy/docs/adr/0005-production-is-served-through-zone-routes-on-a-proxied-aaaa-record.md)
export const bareDashboardRedirect = Effect.fnUntraced(function* (
  request: Request
) {
  const url = new URL(request.url)
  if (url.pathname !== DashboardBasePath) return Option.none<Response>()
  url.pathname = `${DashboardBasePath}/`
  return Option.some(Response.redirect(url.href, 301))
})
