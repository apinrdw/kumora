// The KSEI archive's admin page, /admin/ksei: the last KSEI archive run,
// Run now and Deep backfill, the recent runs, the totals per kind and the
// latest deep run's months not found (spec apinrdw/kumora#327, "The admin
// page").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import type { Action } from "@/server/auth/policy"
import { type KseiTrigger, kseiRunIdAt } from "@/server/ksei/run-result"
import {
  lastKseiDeepRun,
  lastKseiRun,
  recentKseiRuns,
  startKseiRun,
} from "@/server/ksei/runs"
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
  const [run, runs, totals, deep] = yield* Effect.all(
    [lastKseiRun, recentKseiRuns, kseiTotals, lastKseiDeepRun],
    { concurrency: "unbounded" }
  )
  const now = yield* DateTime.now
  return {
    lastRun: run,
    nextRun: (yield* nextKseiRun(DateTime.toDateUtc(now))).toISOString(),
    now: DateTime.formatIso(now),
    recentRuns: runs,
    totals,
    // For the coverage grid: only what it shows of the run.
    lastDeepRun:
      deep?.deep == null
        ? undefined
        : {
            id: deep.id,
            finishedAt: deep.finishedAt,
            monthsNotFound: deep.deep.monthsNotFound,
          },
  }
})

// Starts a `trigger` run now, refused while one is in progress.
const startNow = Effect.fnUntraced(function* (
  trigger: Exclude<KseiTrigger, "cron">
) {
  const id = yield* kseiRunIdAt(
    trigger,
    DateTime.toEpochMillis(yield* DateTime.now)
  )
  const refused = () =>
    Effect.fail(new Conflict({ message: "A run is in progress." }))
  // DuplicateRunId: another start in the same millisecond took the id.
  yield* startKseiRun(id, trigger).pipe(
    Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused })
  )
  return { id }
})

export const runKseiNow = Effect.fn("runKseiNow")(function* (headers: Headers) {
  yield* authorize(headers, "admin.run-ksei-archive")
  return yield* startNow("admin")
})

export const deepBackfillKsei = Effect.fn("deepBackfillKsei")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.deep-backfill-ksei-archive")
  return yield* startNow("deep")
})
