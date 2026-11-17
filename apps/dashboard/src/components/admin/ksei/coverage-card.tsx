import { IconCheck, IconX } from "@tabler/icons-react"
import { Effect } from "effect"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import {
  MarkLegend,
  type MarkStyle,
  MonthGrid,
} from "@/components/admin/archive/month-grid"
import { count, dateTime } from "@/lib/format"
import type { RunId } from "@/server/archive/run"
import type { CoverageState, KseiCoverage } from "@/server/ksei/coverage"
import { KIND_LABEL } from "@/server/ksei/kind"

// Each state differs in shape as well as color: a filled square with a
// check, an outlined square with a cross, an empty dashed square.
const STATE = {
  held: {
    label: "Held",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  "not-found": {
    label: "Not found",
    className: "border-down/80 text-down",
    Icon: IconX,
  },
  "never-looked-for": {
    label: "Never looked for",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<CoverageState, MarkStyle>

// A kind's months in `state`, across every year.
const monthsIn = Effect.fnUntraced(function* (
  years: KseiCoverage[number]["years"],
  state: CoverageState
) {
  return years.reduce(
    (sum, { months }) => sum + months.filter((month) => month === state).length,
    0
  )
})

// A kind's title, with how many of its months are held and not found.
function KindTitle({
  kind,
  years,
}: {
  kind: KseiCoverage[number]["kind"]
  years: KseiCoverage[number]["years"]
}) {
  const notFound = Effect.runSync(monthsIn(years, "not-found"))
  return (
    <>
      {KIND_LABEL[kind]}{" "}
      <span className="font-normal text-muted-foreground">
        · {Effect.runSync(monthsIn(years, "held"))} held
        {notFound > 0 &&
          `, ${Effect.runSync(count(notFound, "month", "months"))} not found`}
      </span>
    </>
  )
}

/**
 * Each KSEI report kind's months from the archive's first (FIRST_MONTH,
 * server/ksei/coverage.ts): held, not found by the latest
 * Deep backfill, or never looked for.
 */
export function KseiCoverageCard({
  coverage,
  lastDeepRun,
}: {
  coverage: KseiCoverage
  lastDeepRun:
    | { readonly id: RunId; readonly finishedAt: string | null }
    | undefined
}) {
  return (
    <ArchiveCard title="Coverage" aside={null}>
      <MarkLegend styles={Object.values(STATE)} />
      <p className="text-[13px] text-muted-foreground">
        {lastDeepRun === undefined ? (
          "No Deep backfill has run yet, so no month without a KSEI report has been looked for."
        ) : (
          <>
            Not found by the latest Deep backfill,{" "}
            <span className="font-mono whitespace-nowrap">
              {lastDeepRun.id}
            </span>
            {lastDeepRun.finishedAt !== null &&
              `, finished ${Effect.runSync(dateTime(lastDeepRun.finishedAt))}`}
            .
          </>
        )}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-6">
        {coverage.map(({ kind, years }) => (
          // Blank before the archive's first month and after today's.
          <MonthGrid
            key={kind}
            title={<KindTitle kind={kind} years={years} />}
            label={`${KIND_LABEL[kind]} coverage`}
            years={years}
            mark={(state) => STATE[state]}
          />
        ))}
      </div>
    </ArchiveCard>
  )
}
