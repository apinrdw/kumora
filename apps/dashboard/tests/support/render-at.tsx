import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { Effect } from "effect"
import type { ReactNode } from "react"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { renderToStaticMarkup } from "react-dom/server"

/**
 * Renders `ui` to static HTML at `url` inside a memory router with only a root
 * route, like the app's, so `Link` and `useMatches` work.
 */
export const renderAt = (url: string, ui: () => ReactNode) =>
  Effect.gen(function* () {
    const rootRoute = createRootRoute({
      component: () => (
        <TooltipProvider>
          {ui()}
          <Outlet />
        </TooltipProvider>
      ),
    })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: [url] }),
    })
    yield* Effect.promise(() => router.load())
    return renderToStaticMarkup(<RouterProvider router={router} />)
  })
