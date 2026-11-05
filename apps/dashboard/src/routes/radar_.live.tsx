import { createFileRoute } from "@tanstack/react-router"

import { parseLiveSearch } from "@/features/radar/live-model"
import { LiveRadarPage } from "@/features/radar/live-page"
import { liveRadarQuery } from "@/features/radar/query"

export const Route = createFileRoute("/radar_/live")({
  staticData: {
    crumbs: () => [
      { label: "Whale Radar", link: { to: "/radar" } },
      { label: "Live" },
    ],
  },
  validateSearch: parseLiveSearch,
  loaderDeps: ({ search }) => ({ symbol: search.s ?? null }),
  loader: ({ deps }) => liveRadarQuery({ data: deps }),
  component: LiveRadarRoute,
})

function LiveRadarRoute() {
  return <LiveRadarPage {...Route.useLoaderData()} />
}
