import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  KseiRecentRunsCard,
  KseiTotalsCard,
} from "@/components/admin/ksei/archive-history"
import { KseiCoverageCard } from "@/components/admin/ksei/coverage-card"
import { KseiLastRunCard } from "@/components/admin/ksei/last-run-card"
import { ParseCoverageCard } from "@/components/admin/archive/parse-coverage-card"
import { ParseRunCard } from "@/components/admin/archive/parse-run-card"
import { kseiArchiveFn, parseKseiNowFn } from "@/server/admin/ksei.functions"
import { KIND_LABEL } from "@/server/ksei/kind"
import { KSEI_PARSE_TIMES_WIB } from "@/server/ksei/schedule"

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
  const {
    recentRuns,
    totals,
    coverage,
    lastDeepRun,
    lastParseRun,
    nextParseRun,
    parseCoverage,
    ...lastRun
  } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-5 py-6">
      <h1 className="text-2xl font-bold">KSEI archive</h1>
      <div className="grid items-start gap-5 xl:grid-cols-[3fr_2fr]">
        <KseiLastRunCard {...lastRun} />
        <ParseRunCard
          title="Last parse run"
          emptyMessage="No KSEI parse run has happened yet."
          lastParseRun={lastParseRun}
          parseNow={parseKseiNowFn}
          times={KSEI_PARSE_TIMES_WIB}
          nextParseRun={nextParseRun}
          now={lastRun.now}
        />
      </div>
      <ParseCoverageCard
        grids={[
          {
            title: KIND_LABEL["securities-holdings"],
            parseCoverage,
          },
        ]}
      />
      <KseiRecentRunsCard runs={recentRuns} />
      <KseiTotalsCard totals={totals} />
      <KseiCoverageCard coverage={coverage} lastDeepRun={lastDeepRun} />
    </div>
  )
}
