import { Effect, Option } from "effect"

type BasePath = "" | `/${string}`

// The dashboard base path: where the dashboard Worker serves its pages,
// sockets, GETs and files, with no trailing slash; "" serves it at the host's
// root. Vite's `base` (apps/dashboard/vite.config.ts) is built from it, and
// TanStack Start takes the router's basepath from that, as the deploy
// package's dashboard Stage URL (packages/deploy/src/target.ts) does its path.
// Every path that skips the router, the relay package's root-relative ones
// included, is joined onto it: `${DashboardBasePath}${path}`. The web
// manifest's icons (apps/dashboard/public/manifest.json) are relative to it,
// so they follow.
// Decision: the dashboard is served under /dashboard on every Stage
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
export const DashboardBasePath: BasePath = "/dashboard"

/**
 * `pathname` read back under `base`: none when it is outside, so not the
 * dashboard's. The Worker entry matches the relay's paths against what is
 * left.
 */
export const pathUnderBase = (
  pathname: string,
  base: BasePath = DashboardBasePath
) =>
  Effect.sync(() => {
    if (pathname === base) return Option.some("/")
    if (!pathname.startsWith(`${base}/`)) return Option.none<string>()
    return Option.some(pathname.slice(base.length))
  })
