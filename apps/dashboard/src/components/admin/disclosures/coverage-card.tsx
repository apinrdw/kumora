import { IconCheck, IconClockHour4 } from "@tabler/icons-react"
import { Effect } from "effect"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import {
  DayGrid,
  MarkLegend,
  type MarkStyle,
} from "@/components/admin/archive/month-grid"
import { count } from "@/lib/format"
import type {
  DisclosureCoverage,
  DisclosureCoverageState,
} from "@/server/disclosures/coverage"
import { RECENT_DAYS } from "@/server/disclosures/disclosure-day"

// Each state differs in shape as well as color: a filled square with a
// check, a filled square with a clock, an empty dashed square.
const STATE = {
  complete: {
    label: "Complete",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  incomplete: {
    label: "Incomplete",
    className: "border-warning/70 bg-warning/20 text-warning",
    Icon: IconClockHour4,
  },
  "not-listed": {
    label: "Not yet listed",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<DisclosureCoverageState, MarkStyle>

/**
 * Each disclosure day from IDX's first to today
 * (server/disclosures/coverage.ts), month by day: complete, incomplete or
 * not yet listed, with how many days are in each and the earliest day the
 * archive holds. Read-only: runs backfill the newest incomplete day first.
 */
export function DisclosureCoverageCard({
  coverage: { earliestDay, complete, incomplete, notListed, months },
}: {
  coverage: DisclosureCoverage
}) {
  return (
    <ArchiveCard title="Coverage" aside={null}>
      <MarkLegend styles={Object.values(STATE)} />
      <p className="text-secondary-text max-w-[65ch] text-[13px] leading-5 text-pretty">
        {earliestDay === null ? (
          "The archive holds no disclosure yet."
        ) : (
          <>
            Holds disclosures from{" "}
            <span className="font-data text-xs whitespace-nowrap">
              {earliestDay}
            </span>
            .
          </>
        )}{" "}
        {Effect.runSync(count(complete, "day complete", "days complete"))},{" "}
        {incomplete} incomplete, {notListed} not yet listed. Each run takes up
        the newest incomplete days before the last {RECENT_DAYS}.
      </p>
      <DayGrid
        title="Disclosure days"
        label="Disclosure coverage"
        months={months}
        mark={({ state }) => STATE[state]}
        // A day's tooltip after its date and state: what it waits for, if
        // anything.
        describe={({ waiting }) =>
          waiting === 0
            ? ""
            : `(${Effect.runSync(count(waiting, "attachment waits", "attachments wait"))})`
        }
      />
    </ArchiveCard>
  )
}
