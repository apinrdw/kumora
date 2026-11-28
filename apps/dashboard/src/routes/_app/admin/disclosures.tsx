import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import { DisclosureCoverageCard } from "@/components/admin/disclosures/coverage-card"
import { DisclosureLastRunCard } from "@/components/admin/disclosures/last-run-card"
import { DisclosureRecentRunsCard } from "@/components/admin/disclosures/recent-runs-card"
import { DisclosureUnavailableCard } from "@/components/admin/disclosures/unavailable-card"
import { disclosureArchiveFn } from "@/server/admin/disclosures.functions"
import { RECENT_DAYS } from "@/server/disclosures/disclosure-day"

export const Route = createFileRoute("/_app/admin/disclosures")({
  staticData: {
    feature: "admin",
    crumbs: () =>
      Effect.succeed([{ label: "Admin" }, { label: "Disclosures" }]),
  },
  loader: () => runLoader(loadServerFn(() => disclosureArchiveFn())),
  head: () => ({ meta: [{ title: "Disclosures · KUMORA Terminal" }] }),
  component: DisclosuresPage,
})

function DisclosuresPage() {
  const { coverage, lastRun, nextRun, now, recentRuns, unavailable } =
    Route.useLoaderData()
  return (
    <div className="flex flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.01em]">
          Disclosures
        </h1>
        <p className="text-secondary-text max-w-[70ch] text-pretty">
          Every disclosure IDX publishes on its Keterbukaan Informasi page, in
          Indonesian and English, with every attachment, kept as published. Run
          now stores what the last {RECENT_DAYS} days added on this stage, then
          backfills the newest days not yet complete.
        </p>
      </header>
      <DisclosureLastRunCard lastRun={lastRun} nextRun={nextRun} now={now} />
      <DisclosureCoverageCard coverage={coverage} />
      <DisclosureUnavailableCard unavailable={unavailable} />
      <DisclosureRecentRunsCard runs={recentRuns} />
    </div>
  )
}
