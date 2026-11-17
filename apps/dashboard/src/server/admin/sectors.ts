// The Sectors card on /admin/shareholding: how many rows stock_sector holds,
// when a sector run last filled it, and Run now, which runs the sector run
// (../sectors/sync.ts) inline. One GET and one batch need no run record.
import { Clock, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import { HoldingsDb } from "@/server/holdings/db"
import { type SectorRun, syncSectors } from "@/server/sectors/sync"

export type SectorSyncOutcome =
  | SectorRun
  | { readonly _tag: "Failed"; readonly message: string }

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
  const [[row]] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT count(*) AS rows, max(fetched_at) AS fetched_at FROM stock_sector",
      params: [],
    },
  ])
  return {
    rows: Number(row?.rows ?? 0),
    // MAX over no rows is NULL.
    fetchedAt: typeof row?.fetched_at === "string" ? row.fetched_at : null,
  }
})

export const runSectorSyncNow = Effect.fn("runSectorSyncNow")(function* (
  headers: Headers
) {
  yield* authorizeArchive(headers, "admin.run-sector-sync", SHAREHOLDING_PATH)
  const now = new Date(yield* Clock.currentTimeMillis)
  // A NonRetryable is IDX failing, not the request: the card shows its
  // message, where a 500 would show none.
  return yield* syncSectors(now).pipe(
    Effect.map((run): SectorSyncOutcome => run),
    Effect.catchTag("NonRetryable", ({ message }) =>
      Effect.succeed<SectorSyncOutcome>({ _tag: "Failed", message })
    )
  )
})
