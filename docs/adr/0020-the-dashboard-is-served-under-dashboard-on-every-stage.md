# The dashboard is served under /dashboard on every Stage

Kumora's public name is one host, `kumora.pusat.ai`, with the web app at its root and the dashboard beside it under `/dashboard`. The dashboard is served under `/dashboard` on every Stage, not only on Production: Staging, Previews, Dev and Test serve it at their own host plus `/dashboard`, so e2e and Staging run the exact shape Production serves and a path that skips the router without the dashboard base path fails in CI, not after a Release. A path outside `/dashboard` on the dashboard's own host redirects into it.

The decision is system-wide, so it lives here rather than in one workspace. Its sites span the dashboard, the deploy package's Stage URLs, the server bridge, the client package, which holds the one definition of the dashboard base path, and the relay's targets. The deploy package imports that definition from the client package to build the dashboard's Stage URL, so the path is written once.

A path the router reads is written without the base path, and the router adds it. An `Unauthorized` error's `redirectTo` is such a router path, with its search, so every site that refuses a page names the same path on every Stage, and the server bridge hands it to the router as a route and search instead of an `href`.

A subdomain (`dashboard.kumora.pusat.ai`) would have left the dashboard at its host's root and changed no path. It was given up for one memorable address and one origin for both apps. The cost is that every path that skips the router (sockets, the recorded-day GETs, logos, Better Auth's base and callback URLs, the relay's ingest URL) joins the dashboard base path, Better Auth's base URL is set in full, and the Stage URL may carry a path, so a caller that needs only a host or origin reads it from the URL. Undoing it means moving every one of those back and every outside URL set up for the dashboard (Google's redirect URIs, the relay's targets).

Sites:
- `packages/client/src/base-path.ts`
- `packages/deploy/src/target.ts`
- `packages/deploy/src/stage-url.ts`
- `apps/dashboard/vite.config.ts`
- `apps/dashboard/src/server/base-redirect.ts`
- `packages/server/src/bridge.ts`
- `packages/server/src/errors.ts`
- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#683
