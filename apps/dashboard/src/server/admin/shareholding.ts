// The shareholding archive's admin page, /admin/shareholding: the last archive
// run and Run now, the recent runs and the archive totals (spec apinrdw/kumora#303, "The admin page").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import type { Action } from "@/server/auth/policy"
import { lastRun, recentRuns, startRun } from "@/server/shareholding/runs"
import { archiveTotals } from "@/server/shareholding/totals"
import { runIdAt } from "@/server/shareholding/run-result"
import { nextScheduledRun } from "@/server/shareholding/schedule"

const SHAREHOLDING_PATH =
  "/admin/shareholding" satisfies keyof FileRoutesByFullPath

const authorize = (
  headers: Headers,
  action: Extract<Action, `admin.${string}-shareholding-archive`>
) => authorizeArchive(headers, action, SHAREHOLDING_PATH)

export const shareholdingArchivePage = Effect.fn("shareholdingArchivePage")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.view-shareholding-archive")
    const [run, runs, totals] = yield* Effect.all(
      [lastRun, recentRuns, archiveTotals],
      { concurrency: "unbounded" }
    )
    const now = yield* DateTime.now
    return {
      lastRun: run,
      nextRun: (yield* nextScheduledRun(DateTime.toDateUtc(now))).toISOString(),
      now: DateTime.formatIso(now),
      recentRuns: runs,
      totals,
    }
  }
)

export const runArchiveNow = Effect.fn("runArchiveNow")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.run-shareholding-archive")
  const id = yield* runIdAt(
    "admin",
    DateTime.toEpochMillis(yield* DateTime.now)
  )
  const refused = () =>
    Effect.fail(new Conflict({ message: "A run is in progress." }))
  // DuplicateRunId: another Run now in the same millisecond took the id.
  yield* startRun(id, "admin").pipe(
    Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused })
  )
  return { id }
})
