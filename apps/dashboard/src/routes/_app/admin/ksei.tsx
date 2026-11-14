import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  KseiRecentRunsCard,
  KseiTotalsCard,
} from "@/components/admin/ksei/archive-history"
import { KseiCoverageCard } from "@/components/admin/ksei/coverage-card"
import { KseiLastRunCard } from "@/components/admin/ksei/last-run-card"
import { kseiArchiveFn } from "@/server/admin/ksei.functions"

export const Route = createFileRoute("/_app/admin/ksei")({
  staticData: {
    feature: "admin",
    crumbs: () =>
      Effect.succeed([{ label: "Admin" }, { label: "KSEI archive" }]),
  },
  loader: () => runLoader(loadServerFn(() => kseiArchiveFn())),
  head: () => ({ meta: [{ title: "KSEI archive · KUMORA Terminal" }] }),
  component: KseiPage,
})

function KseiPage() {
  const { recentRuns, totals, coverage, lastDeepRun, ...lastRun } =
    Route.useLoaderData()
  return (
    <div className="flex flex-col gap-5 py-6">
      <h1 className="text-2xl font-bold">KSEI archive</h1>
      <KseiLastRunCard {...lastRun} />
      <KseiRecentRunsCard runs={recentRuns} />
      <KseiTotalsCard totals={totals} />
      <KseiCoverageCard coverage={coverage} lastDeepRun={lastDeepRun} />
    </div>
  )
}
