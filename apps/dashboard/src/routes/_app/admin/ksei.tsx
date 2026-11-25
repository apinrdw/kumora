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
    <div className="flex flex-col gap-6 py-6">
      <header className="flex max-w-[65ch] flex-col gap-2">
        <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.02em]">
          KSEI archive
        </h1>
        <p className="text-secondary-text text-[15px] leading-6 text-pretty">
          Every {KIND_LABEL["securities-statistics"]} and{" "}
          {KIND_LABEL["securities-holdings"]} report KSEI publishes, kept with
          each version, and the holdings parsed for the stock pages.
        </p>
      </header>
      {/* At xl, the archive's column on the left and its parse
          run's on the right, each run over its coverage, so neither card
          leaves a hole beside a taller one. Narrower, the columns dissolve
          (contents) and both run cards come first, so Parse now stays near
          the top; no coverage card holds a focus stop before it. */}
      <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[3fr_2fr] xl:items-start">
        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-6">
          <div className="order-1 min-w-0">
            <KseiLastRunCard {...lastRun} />
          </div>
          <div className="order-3 min-w-0">
            <KseiCoverageCard coverage={coverage} lastDeepRun={lastDeepRun} />
          </div>
        </div>
        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-6">
          <div className="order-2 min-w-0">
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
          <div className="order-4 min-w-0">
            <ParseCoverageCard
              grids={[
                {
                  title: KIND_LABEL["securities-holdings"],
                  layout: "month",
                  parseCoverage,
                },
              ]}
            />
          </div>
        </div>
      </div>
      <KseiRecentRunsCard runs={recentRuns} />
      <KseiTotalsCard totals={totals} />
    </div>
  )
}
