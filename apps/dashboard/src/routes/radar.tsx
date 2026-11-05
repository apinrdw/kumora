import { createFileRoute } from "@tanstack/react-router"

import { parseRadarSearch } from "@/features/radar/model"
import { radarQuery } from "@/features/radar/query"
import { RadarPage } from "@/features/radar/radar-page"

export const Route = createFileRoute("/radar")({
  staticData: {
    crumbs: () => [
      { label: "Whale Radar", link: { to: "/radar" } },
      { label: "Candidate discovery" },
    ],
  },
  validateSearch: parseRadarSearch,
  loader: () => radarQuery(),
  component: RadarRoute,
})

function RadarRoute() {
  return <RadarPage snapshot={Route.useLoaderData()} />
}
