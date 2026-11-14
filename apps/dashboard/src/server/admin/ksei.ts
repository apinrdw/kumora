// The KSEI archive's admin page, /admin/ksei: the last KSEI archive run and
// Run now, the recent runs and the totals per kind (spec apinrdw/kumora#327,
// "The admin page").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import type { Action } from "@/server/auth/policy"
import { kseiRunIdAt } from "@/server/ksei/run-result"
import { lastKseiRun, recentKseiRuns, startKseiRun } from "@/server/ksei/runs"
import { nextKseiRun } from "@/server/ksei/schedule"
import { kseiTotals } from "@/server/ksei/totals"

const KSEI_PATH = "/admin/ksei" satisfies keyof FileRoutesByFullPath

const authorize = (
  headers: Headers,
  action: Extract<Action, `admin.${string}-ksei-archive`>
) => authorizeArchive(headers, action, KSEI_PATH)

export const kseiArchivePage = Effect.fn("kseiArchivePage")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.view-ksei-archive")
  const [run, runs, totals] = yield* Effect.all(
    [lastKseiRun, recentKseiRuns, kseiTotals],
    { concurrency: "unbounded" }
  )
  const now = yield* DateTime.now
  return {
    lastRun: run,
    nextRun: (yield* nextKseiRun(DateTime.toDateUtc(now))).toISOString(),
    now: DateTime.formatIso(now),
    recentRuns: runs,
    totals,
  }
})

export const runKseiNow = Effect.fn("runKseiNow")(function* (headers: Headers) {
  yield* authorize(headers, "admin.run-ksei-archive")
  const id = yield* kseiRunIdAt(
    "admin",
    DateTime.toEpochMillis(yield* DateTime.now)
  )
  const refused = () =>
    Effect.fail(new Conflict({ message: "A run is in progress." }))
  // DuplicateRunId: another Run now in the same millisecond took the id.
  yield* startKseiRun(id, "admin").pipe(
    Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused })
  )
  return { id }
})
