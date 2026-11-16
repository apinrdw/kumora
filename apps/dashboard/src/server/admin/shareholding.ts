// The shareholding archive's admin page, /admin/shareholding: the last archive
// run and Run now, the last classification parse run and its Parse now, the
// recent runs and the archive totals (spec apinrdw/kumora#303, "The admin
// page", and #402, "Admin").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import { parseNow } from "@/server/admin/parse-now"
import type { Action } from "@/server/auth/policy"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"
import { lastRun, recentRuns, startRun } from "@/server/shareholding/runs"
import { archiveTotals } from "@/server/shareholding/totals"
import { runIdAt } from "@/server/shareholding/run-result"
import { nextParseRun, nextScheduledRun } from "@/server/shareholding/schedule"

const SHAREHOLDING_PATH =
  "/admin/shareholding" satisfies keyof FileRoutesByFullPath

const authorize = (
  headers: Headers,
  action: Extract<
    Action,
    `admin.${string}-shareholding-archive` | "admin.run-shareholding-parse"
  >
) => authorizeArchive(headers, action, SHAREHOLDING_PATH)

export const shareholdingArchivePage = Effect.fn("shareholdingArchivePage")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.view-shareholding-archive")
    const [run, runs, totals, classificationParseRun] = yield* Effect.all(
      [lastRun, recentRuns, archiveTotals, classificationParseRuns.last],
      { concurrency: "unbounded" }
    )
    const now = yield* DateTime.now
    return {
      lastRun: run,
      nextRun: (yield* nextScheduledRun(DateTime.toDateUtc(now))).toISOString(),
      lastClassificationParseRun: classificationParseRun,
      nextParseRun: (yield* nextParseRun(
        DateTime.toDateUtc(now)
      )).toISOString(),
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

export const parseClassificationNow = Effect.fn("parseClassificationNow")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.run-shareholding-parse")
    return yield* parseNow(classificationParseRuns)
  }
)
