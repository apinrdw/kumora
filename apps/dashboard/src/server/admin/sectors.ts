// The Sectors card on /admin/shareholding: how many rows stock_sector holds,
// when a sector run last filled it, the last run's outcome, and Run now,
// which runs the sector run (../sectors/sync.ts) inline.
import { Clock, Effect, Schema } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import { HoldingsDb } from "@/server/holdings/db"
import {
  type RecordedSectorRun,
  recordedSectorRun,
} from "@/server/sectors/sync"

// sector_last_run's row, as its CHECK allows it.
const LastRunRow = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("Replaced"),
    rows: Schema.Number,
    skipped: Schema.fromJsonString(Schema.Array(Schema.String)),
    ran_at: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.Literals(["Kept", "Failed"]),
    message: Schema.String,
    ran_at: Schema.String,
  }),
])
const decodeLastRun = Schema.decodeUnknownOption(LastRunRow)

export interface LastSectorRun {
  readonly run: RecordedSectorRun
  // An ISO instant.
  readonly ranAt: string
}

const lastRunOf = (row: unknown): LastSectorRun | null => {
  const decoded = decodeLastRun(row)
  if (decoded._tag === "None") return null
  const last = decoded.value
  const run: RecordedSectorRun =
    last.outcome === "Replaced"
      ? { _tag: "Replaced", rows: last.rows, skipped: last.skipped }
      : last.outcome === "Kept"
        ? { _tag: "Kept", reason: last.message }
        : { _tag: "Failed", message: last.message }
  return { run, ranAt: last.ran_at }
}

const SHAREHOLDING_PATH =
  "/admin/shareholding" satisfies keyof FileRoutesByFullPath

export const sectorTable = Effect.fn("sectorTable")(function* (
  headers: Headers
) {
  yield* authorizeArchive(
    headers,
    "admin.view-shareholding-archive",
    SHAREHOLDING_PATH
  )
  const [[row], [last]] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT count(*) AS rows, max(fetched_at) AS fetched_at FROM stock_sector",
      params: [],
    },
    {
      sql: "SELECT outcome, rows, skipped, message, ran_at FROM sector_last_run WHERE id = 1",
      params: [],
    },
  ])
  return {
    rows: Number(row?.rows ?? 0),
    // MAX over no rows is NULL.
    fetchedAt: typeof row?.fetched_at === "string" ? row.fetched_at : null,
    // Null before the first recorded run.
    lastRun: last === undefined ? null : lastRunOf(last),
  }
})

export const runSectorSyncNow = Effect.fn("runSectorSyncNow")(function* (
  headers: Headers
) {
  yield* authorizeArchive(headers, "admin.run-sector-sync", SHAREHOLDING_PATH)
  return yield* recordedSectorRun(new Date(yield* Clock.currentTimeMillis))
})
