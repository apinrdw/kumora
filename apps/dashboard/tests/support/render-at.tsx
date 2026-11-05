import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { renderToStaticMarkup } from "react-dom/server"

import { parseLiveSearch } from "@/features/radar/live-model"
import { parseRadarSearch } from "@/features/radar/model"
import type { MarketOverview } from "@/features/shell/schema"
import { MARKET_OVERVIEW } from "@/lib/market"

/**
 * Renders `ui` to static HTML at `url` inside a memory router whose route ids
 * match the app's, so `Link`, `useNavigate` and `useSearch({ from })` work.
 * Like the app's root loader, the root route's loader serves `overview`.
 */
export async function renderAt(
  url: string,
  ui: () => ReactNode,
  { overview = MARKET_OVERVIEW }: { overview?: MarketOverview } = {}
) {
  const rootRoute = createRootRoute({
    loader: () => overview,
    component: () => (
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    ),
  })
  const page = () => <>{ui()}</>
  const route = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: page })
  const routeTree = rootRoute.addChildren([
    route("/"),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/radar",
      validateSearch: parseRadarSearch,
      component: page,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/radar/live",
      validateSearch: parseLiveSearch,
      component: page,
    }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}
