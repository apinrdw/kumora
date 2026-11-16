// The KSEI archive's admin page, /admin/ksei: the last KSEI archive run,
// Run now and Deep backfill, the last KSEI parse run and Parse now, the
// recent runs, the totals per kind and the latest deep run's months not
// found (spec apinrdw/kumora#327, "The admin page", and #363, "KSEI parse
// run").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import { ArchiveBucket } from "@/server/archive/bucket"
import { dailyRunIdAt, REPORTS_PREFIX } from "@/server/archive/run"
import type { Action } from "@/server/auth/policy"
import { kseiCoverage } from "@/server/ksei/coverage"
import { parseNow } from "@/server/admin/parse-now"
import { kseiParseRuns } from "@/server/ksei/parse-runs"
import type { KseiTrigger } from "@/server/ksei/run-result"
import {
  lastKseiDeepRun,
  lastKseiRun,
  recentKseiRuns,
  startKseiRun,
} from "@/server/ksei/runs"
import { nextKseiParseRun, nextKseiRun } from "@/server/ksei/schedule"
import { kseiTotals } from "@/server/ksei/totals"

const KSEI_PATH = "/admin/ksei" satisfies keyof FileRoutesByFullPath

const authorize = (
  headers: Headers,
  action:
    | Extract<Action, `admin.${string}-ksei-archive`>
    | "admin.run-ksei-parse"
) => authorizeArchive(headers, action, KSEI_PATH)

export const kseiArchivePage = Effect.fn("kseiArchivePage")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.view-ksei-archive")
  // One listing of reports/ gives the totals and the coverage: ~150 objects
  // after the first run, ~1,000 after a deep backfill, far within
  // MAX_LISTED_OBJECTS.
  const reports = Effect.gen(function* () {
    return yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  })
  const [run, runs, objects, deep, parseRun] = yield* Effect.all(
    [lastKseiRun, recentKseiRuns, reports, lastKseiDeepRun, kseiParseRuns.last],
    { concurrency: "unbounded" }
  )
  const now = yield* DateTime.now
  return {
    lastRun: run,
    nextRun: (yield* nextKseiRun(DateTime.toDateUtc(now))).toISOString(),
    lastParseRun: parseRun,
    nextParseRun: (yield* nextKseiParseRun(
      DateTime.toDateUtc(now)
    )).toISOString(),
    now: DateTime.formatIso(now),
    recentRuns: runs,
    totals: yield* kseiTotals(objects),
    // The deep run the coverage's months not found come from.
    lastDeepRun:
      deep?.deep == null
        ? undefined
        : { id: deep.id, finishedAt: deep.finishedAt },
    coverage: yield* kseiCoverage(objects, deep?.deep?.monthsNotFound, now),
  }
})

// Starts a `trigger` run now, refused while one is in progress.
const startNow = Effect.fnUntraced(function* (
  trigger: Exclude<KseiTrigger, "cron">
) {
  const id = yield* dailyRunIdAt(
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

// Starts a KSEI parse run now, refused while one is queued or running.
export const parseKseiNow = Effect.fn("parseKseiNow")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.run-ksei-parse")
  return yield* parseNow(kseiParseRuns)
})
