import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { renderToStaticMarkup } from "react-dom/server"

/**
 * Renders `ui` to static HTML at `url` inside a memory router with only a root
 * route, like the app's, so `Link` and `useMatches` work.
 */
export async function renderAt(url: string, ui: () => ReactNode) {
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
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}
