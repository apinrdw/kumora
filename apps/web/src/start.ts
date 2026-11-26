import { createMiddleware, createStart } from "@tanstack/react-start"
import { loaderErrorAdapter } from "@workspace/server/loader"
import { Effect, Option } from "effect"

import { bareDashboardRedirect } from "./server/dashboard-redirect.ts"

// Answered before any route, on every request.
const dashboardRedirect = createMiddleware().server(({ request, next }) =>
  Option.getOrElse(Effect.runSync(bareDashboardRedirect(request)), () => next())
)

export const startInstance = createStart(() => ({
  requestMiddleware: [dashboardRedirect],
  serializationAdapters: [loaderErrorAdapter],
}))
