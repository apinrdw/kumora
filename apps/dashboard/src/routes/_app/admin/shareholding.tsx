import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  ArchiveTotalsCard,
  RecentRunsCard,
} from "@/components/admin/archive-history"
import { LastRunCard } from "@/components/admin/last-run-card"
import { shareholdingArchiveFn } from "@/server/admin/shareholding.functions"

export const Route = createFileRoute("/_app/admin/shareholding")({
  staticData: {
    feature: "admin",
    crumbs: () =>
      Effect.succeed([{ label: "Admin" }, { label: "Shareholding archive" }]),
  },
  loader: () => runLoader(loadServerFn(() => shareholdingArchiveFn())),
  head: () => ({ meta: [{ title: "Shareholding archive · KUMORA Terminal" }] }),
  component: ShareholdingPage,
})

function ShareholdingPage() {
  const { recentRuns, totals, ...lastRun } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-5 py-6">
      <h1 className="text-2xl font-bold">Shareholding archive</h1>
      <LastRunCard {...lastRun} />
      <RecentRunsCard runs={recentRuns} />
      <ArchiveTotalsCard totals={totals} />
    </div>
  )
}
