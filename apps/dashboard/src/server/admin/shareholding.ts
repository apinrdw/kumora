// The shareholding archive's admin page, /admin/shareholding: the last archive
// run and Run now, the last parse run of each kind (parse-runs.ts) with its
// Parse now, the classification and investor-type parse coverage, the recent
// runs and the archive totals (spec apinrdw/kumora#303, "The admin page",
// #402, "Admin", #458, and #479, "Admin").
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { authorizeArchive } from "@/server/admin/archive-access"
import { parseNow } from "@/server/admin/parse-now"
import { timePart } from "@/server/admin/part-timing"
import type { Action } from "@/server/auth/policy"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"
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

const timed = (part: string) => timePart("shareholding", part)

export const shareholdingArchivePage = Effect.fn("shareholdingArchivePage")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.view-shareholding-archive").pipe(
      timed("authorize")
    )
    const [
      run,
      runs,
      totals,
      classificationParseRun,
      investorTypeParseRun,
      above1ParseRun,
      classificationParseCoverage,
      investorTypeParseCoverage,
    ] = yield* Effect.all(
      [
        lastRun.pipe(timed("lastRun")),
        recentRuns.pipe(timed("recentRuns")),
        archiveTotals.pipe(timed("totals")),
        classificationParseRuns.last.pipe(timed("lastClassificationParseRun")),
        investorTypeParseRuns.last.pipe(timed("lastInvestorTypeParseRun")),
        above1ParseRuns.last.pipe(timed("lastAbove1ParseRun")),
        classificationParseRuns.parseCoverage.pipe(
          timed("classificationParseCoverage")
        ),
        investorTypeParseRuns.parseCoverage.pipe(
          timed("investorTypeParseCoverage")
        ),
      ],
      { concurrency: "unbounded" }
    ).pipe(timed("reads"))
    const now = yield* DateTime.now
    return {
      lastRun: run,
      nextRun: (yield* nextScheduledRun(DateTime.toDateUtc(now))).toISOString(),
      lastClassificationParseRun: classificationParseRun,
      lastInvestorTypeParseRun: investorTypeParseRun,
      lastAbove1ParseRun: above1ParseRun,
      classificationParseCoverage,
      investorTypeParseCoverage,
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

export const parseInvestorTypeNow = Effect.fn("parseInvestorTypeNow")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.run-shareholding-parse")
    return yield* parseNow(investorTypeParseRuns)
  }
)

export const parseAbove1Now = Effect.fn("parseAbove1Now")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.run-shareholding-parse")
  return yield* parseNow(above1ParseRuns)
})
