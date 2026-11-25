// The Sectors card: what stock_sector holds, the last sector run's outcome,
// and Run now, which runs the sector run inline
// (../../../server/admin/sectors.ts).
import { IconPlayerPlay } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Exit } from "effect"

import {
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "@/components/account/account-section"
import {
  ArchiveRow,
  archiveRowStats,
} from "@/components/admin/archive/archive-card"
import { KButton } from "@/components/k"
import { dateTime } from "@/lib/format"
import type { LastSectorRun } from "@/server/admin/sectors"
import { runSectorSyncNowFn } from "@/server/admin/sectors.functions"
import { SECTOR_TIME_WIB } from "@/server/sectors/schedule"
import type { RecordedSectorRun } from "@/server/sectors/sync"

// Up to the 90 % gate's ~94 profiles can be skipped; ten name the cause.
const SKIPPED_SHOWN = 10

const skippedList = (skipped: ReadonlyArray<string>) =>
  skipped.length <= SKIPPED_SHOWN
    ? skipped.join(", ")
    : `${skipped.slice(0, SKIPPED_SHOWN).join(", ")} and ${skipped.length - SKIPPED_SHOWN} more`

const outcomeOf = (run: RecordedSectorRun): Outcome => {
  switch (run._tag) {
    case "Replaced":
      return {
        _tag: "Done",
        message:
          run.skipped.length === 0
            ? `Replaced ${run.rows} rows.`
            : `Replaced ${run.rows} rows, skipping ${skippedList(run.skipped)}.`,
      }
    case "Kept":
      return { _tag: "Failed", message: `Kept the table: ${run.reason}` }
    case "Failed":
      return { _tag: "Failed", message: run.message }
  }
}

const runNow: Effect.Effect<Outcome> = Effect.map(
  Effect.exit(loadServerFn(runSectorSyncNowFn)),
  Exit.match({
    onSuccess: outcomeOf,
    onFailure: () => ({
      _tag: "Failed",
      message: "Couldn't run the sector run. Try again.",
    }),
  })
)

// The last run's outcome and when it ran, red when it kept the table or
// failed.
function LastRun({ lastRun }: { lastRun: LastSectorRun | null }) {
  if (lastRun === null) return <>Never</>
  const { _tag, message } = outcomeOf(lastRun.run)
  return (
    <span className={_tag === "Done" ? undefined : "text-down"}>
      {message} {Effect.runSync(dateTime(lastRun.ranAt))}
    </span>
  )
}

/** The sector table's row count, last fill and last run, with Run now: a
 * row of the page's ledger. */
export function SectorsCard({
  rows,
  fetchedAt,
  lastRun,
}: {
  rows: number
  // An ISO instant, or null while the table is empty.
  fetchedAt: string | null
  lastRun: LastSectorRun | null
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  return (
    <ArchiveRow
      title="Sectors"
      meta={
        <p className="text-secondary-text text-[13px]">
          Production fills{" "}
          <span className="font-data text-xs">stock_sector</span> from IDX's
          company profiles at {SECTOR_TIME_WIB}. Other stages fill it with Run
          now.
        </p>
      }
      stats={
        <dl className={archiveRowStats}>
          {/* Set like the other rows' counts, a 0 muted, so the ledger's
              columns read as one. */}
          <div className="flex flex-col-reverse justify-end gap-0.5">
            <dt className="text-secondary-text text-[13px]">Rows</dt>
            <dd
              className={cn(
                "font-data text-xl leading-7 font-semibold tabular-nums",
                rows === 0 && "text-muted-foreground"
              )}
            >
              {rows}
            </dd>
          </div>
          <div className="flex flex-col-reverse justify-end gap-0.5">
            <dt className="text-secondary-text text-[13px]">Last filled</dt>
            <dd
              className={cn(
                "num text-[15px] leading-7 font-semibold",
                fetchedAt === null && "text-muted-foreground"
              )}
            >
              {fetchedAt === null
                ? "Never"
                : Effect.runSync(dateTime(fetchedAt))}
            </dd>
          </div>
          <div className="col-span-full flex flex-col-reverse justify-end gap-0.5 sm:col-span-2">
            <dt className="text-secondary-text text-[13px]">Last run</dt>
            <dd className="text-[13px] leading-7">
              <LastRun lastRun={lastRun} />
            </dd>
          </div>
        </dl>
      }
      aside={
        <div className="flex flex-col items-end gap-1">
          <KButton
            icon={IconPlayerPlay}
            variant="secondary"
            disabled={!hydrated}
            loading={pending}
            onClick={() => clientRuntime.runFork(run(runNow))}
          >
            Run now
          </KButton>
          <OutcomeLine outcome={outcome} />
        </div>
      }
    />
  )
}
