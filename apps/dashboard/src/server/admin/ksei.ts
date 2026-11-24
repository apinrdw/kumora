// The KSEI archive's admin page, /admin/ksei: the last KSEI archive run,
// Run now and Deep backfill, the last KSEI parse run and Parse now, the
// recent runs, the totals per kind, the latest deep run's months not found
// and the KSEI parse run's parse coverage (spec apinrdw/kumora#327, "The
// admin page", #363, "KSEI parse run", and #458).
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import {
  authorizeArchive,
  importingAsConflict,
} from "@/server/admin/archive-access"
import { readPage } from "@/server/archive/page-read"
import { dailyRunIdAt } from "@/server/archive/run"
import type { Action } from "@/server/auth/policy"
import { kseiCoverage } from "@/server/ksei/coverage"
import { parseNow } from "@/server/admin/parse-now"
import { timePart } from "@/server/admin/part-timing"
import { kseiParseRuns } from "@/server/ksei/parse-runs"
import { kseiReportIndex } from "@/server/ksei/report-index"
import type { KseiTrigger } from "@/server/ksei/run-result"
import {
  lastKseiDeepRun,
  lastKseiRun,
  recentKseiRuns,
  startKseiRun,
} from "@/server/ksei/runs"
import { nextKseiParseRun, nextKseiRun } from "@/server/ksei/schedule"

const KSEI_PATH = "/admin/ksei" satisfies keyof FileRoutesByFullPath

const authorize = (
  headers: Headers,
  action:
    | Extract<Action, `admin.${string}-ksei-archive`>
    | "admin.run-ksei-parse"
) => authorizeArchive(headers, action, KSEI_PATH)

const timed = (part: string) => timePart("ksei", part)

export const kseiArchivePage = Effect.fn("kseiArchivePage")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.view-ksei-archive").pipe(timed("authorize"))
  const now = yield* DateTime.now
  const read = yield* readPage(
    {
      lastRun: lastKseiRun,
      recentRuns: recentKseiRuns(now),
      reportIndex: kseiReportIndex,
      lastDeepRun: lastKseiDeepRun,
      lastParseRun: kseiParseRuns.last,
      parseCoverage: kseiParseRuns.parseCoverage,
    },
    timed
  ).pipe(timed("reads"), importingAsConflict)
  const deep = read.lastDeepRun
  return {
    lastRun: read.lastRun,
    nextRun: (yield* nextKseiRun(DateTime.toDateUtc(now))).toISOString(),
    lastParseRun: read.lastParseRun,
    nextParseRun: (yield* nextKseiParseRun(
      DateTime.toDateUtc(now)
    )).toISOString(),
    now: DateTime.formatIso(now),
    recentRuns: read.recentRuns,
    totals: read.reportIndex.totals,
    // The deep run the coverage's months not found come from.
    lastDeepRun:
      deep?.deep == null
        ? undefined
        : { id: deep.id, finishedAt: deep.finishedAt },
    coverage: yield* kseiCoverage(
      read.reportIndex.monthsHeld,
      deep?.deep?.monthsNotFound,
      now
    ),
    parseCoverage: read.parseCoverage,
  }
})

// Starts a `trigger` run now, refused while one is in progress or the
// archive's runs are still importing.
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
    Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused }),
    importingAsConflict
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
