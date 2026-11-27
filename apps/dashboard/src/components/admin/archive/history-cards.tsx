// An archive's view over time: its recent runs and its totals per kind. The
// archive passes in its own columns: its run counts and its kinds.
import { Effect } from "effect"

import { KDataTable, type KColumn } from "@/components/k"
import { byteSize, count, dateTime } from "@/lib/format"
import { RETENTION_DAYS } from "@/server/archive/retention"
import type { RunSummaryBase } from "@/server/archive/run"

import { ArchiveCard, RunStatus } from "./archive-card"

// A table running to the panel's edges, under the panel's header rule, so
// it is not a box inside the panel's box. Last in the panel, it runs to the
// panel's foot too.
export const FLUSH =
  "-mx-5 -mt-5 max-w-none rounded-none border-x-0 border-t-0 last:-mb-6 last:border-b-0"

const RUN_COLUMNS: ReadonlyArray<KColumn<RunSummaryBase>> = [
  {
    key: "startedAt",
    label: "Started (WIB)",
    cell: (run) => Effect.runSync(dateTime(run.startedAt)),
  },
  {
    key: "id",
    label: "Run",
    cell: (run) => <span className="font-data text-xs">{run.id}</span>,
  },
  {
    key: "outcome",
    label: "Outcome",
    cell: (run) => <RunStatus outcome={run.outcome} />,
  },
]

/**
 * The runs of the past 30 days, newest first: each run's start, id and
 * outcome, then the archive's `counts` columns.
 */
export function ArchiveRecentRunsCard<Run extends RunSummaryBase>({
  runs,
  counts,
}: {
  runs: ReadonlyArray<Run>
  counts: ReadonlyArray<KColumn<Run>>
}) {
  return (
    <ArchiveCard title="Recent runs" aside={null}>
      <KDataTable<Run>
        label="Recent runs"
        columns={[...RUN_COLUMNS, ...counts]}
        rows={runs}
        getRowId={(run) => run.id}
        className={FLUSH}
        state={
          runs.length === 0
            ? {
                status: "empty",
                title: `No archive run in the past ${RETENTION_DAYS} days.`,
                description: `Runs show here for ${RETENTION_DAYS} days after they start.`,
              }
            : { status: "ready" }
        }
      />
      <p className="text-secondary-text text-[13px]">
        Kept {RETENTION_DAYS} days.
      </p>
    </ArchiveCard>
  )
}

/**
 * An archive's stored reports and their size, with a table of `rows`, one
 * per kind, or `emptyMessage` before any report.
 */
export function KindTotalsCard<Row extends object>({
  title,
  reports,
  bytes,
  emptyMessage,
  label,
  columns,
  rows,
  getRowId,
}: {
  title: string
  reports: number
  bytes: number
  emptyMessage: string
  // The table's accessible name.
  label: string
  columns: ReadonlyArray<KColumn<Row>>
  rows: ReadonlyArray<Row>
  getRowId: (row: Row) => string
}) {
  return (
    <ArchiveCard
      title={title}
      aside={
        <span className="font-data text-secondary-text text-[13px]">
          {Effect.runSync(count(reports, "report", "reports"))} ·{" "}
          {Effect.runSync(byteSize(bytes))}
        </span>
      }
    >
      {reports === 0 ? (
        <p className="text-secondary-text border-strong rounded-sm border border-dashed px-4 py-6 text-center text-sm leading-5 text-pretty">
          {emptyMessage}
        </p>
      ) : (
        <KDataTable
          label={label}
          columns={columns}
          rows={rows}
          getRowId={getRowId}
          className={FLUSH}
        />
      )}
    </ArchiveCard>
  )
}
