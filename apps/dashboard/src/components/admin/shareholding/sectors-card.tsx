// The Sectors card: what stock_sector holds and Run now, which runs the
// sector run inline (../../../server/admin/sectors.ts).
import { IconPlayerPlay } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { Effect, Exit } from "effect"

import {
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "@/components/account/account-section"
import { ArchiveCard } from "@/components/admin/archive/archive-card"
import { KButton } from "@/components/k"
import { dateTime } from "@/lib/format"
import type { SectorSyncOutcome } from "@/server/admin/sectors"
import { runSectorSyncNowFn } from "@/server/admin/sectors.functions"
import { SECTOR_TIME_WIB } from "@/server/sectors/schedule"

const outcomeOf = (run: SectorSyncOutcome): Outcome => {
  switch (run._tag) {
    case "Replaced":
      return { _tag: "Done", message: `Replaced ${run.rows} rows.` }
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

/** The sector table's row count and last fill, with Run now. */
export function SectorsCard({
  rows,
  fetchedAt,
}: {
  rows: number
  // An ISO instant, or null while the table is empty.
  fetchedAt: string | null
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  return (
    <ArchiveCard
      title="Sectors"
      aside={
        <div className="flex flex-col items-end gap-1">
          <KButton
            icon={IconPlayerPlay}
            variant="primary"
            disabled={!hydrated}
            loading={pending}
            onClick={() => clientRuntime.runFork(run(runNow))}
          >
            Run now
          </KButton>
          <OutcomeLine outcome={outcome} />
        </div>
      }
    >
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
        <div className="flex flex-col-reverse gap-0.5">
          <dt className="text-xs text-muted-foreground">Rows</dt>
          <dd className="num text-xl font-semibold">{rows}</dd>
        </div>
        <div className="flex flex-col-reverse gap-0.5">
          <dt className="text-xs text-muted-foreground">Last filled</dt>
          <dd className="num text-[15px] font-semibold">
            {fetchedAt === null ? "Never" : Effect.runSync(dateTime(fetchedAt))}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Production fills stock_sector from IDX's company profiles at{" "}
        {SECTOR_TIME_WIB}. Other stages fill it with Run now.
      </p>
    </ArchiveCard>
  )
}
