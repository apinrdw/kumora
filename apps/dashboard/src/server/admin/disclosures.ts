// The disclosure archive's admin page, /admin/disclosures: the last
// disclosure run, Run now and the recent runs (spec apinrdw/kumora#715,
// ticket #716).
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import {
  authorizeArchive,
  importingAsConflict,
} from "@/server/admin/archive-access"
import { timePart } from "@/server/admin/part-timing"
import { readPage } from "@/server/archive/page-read"
import { disclosureRunIdAt } from "@/server/disclosures/run-result"
import {
  lastDisclosureRun,
  recentDisclosureRuns,
  startDisclosureRun,
} from "@/server/disclosures/runs"

const DISCLOSURES_PATH =
  "/admin/disclosures" satisfies keyof FileRoutesByFullPath

const timed = (part: string) => timePart("disclosures", part)

export const disclosureArchivePage = Effect.fn("disclosureArchivePage")(
  function* (headers: Headers) {
    yield* authorizeArchive(
      headers,
      "admin.view-disclosure-archive",
      DISCLOSURES_PATH
    ).pipe(timed("authorize"))
    const now = yield* DateTime.now
    const read = yield* readPage(
      {
        lastRun: lastDisclosureRun,
        recentRuns: recentDisclosureRuns(now),
      },
      timed
    ).pipe(timed("reads"), importingAsConflict)
    return {
      lastRun: read.lastRun,
      now: DateTime.formatIso(now),
      recentRuns: read.recentRuns,
    }
  }
)

// Starts a run now, refused while one is in progress.
export const runDisclosuresNow = Effect.fn("runDisclosuresNow")(function* (
  headers: Headers
) {
  yield* authorizeArchive(
    headers,
    "admin.run-disclosure-archive",
    DISCLOSURES_PATH
  )
  const id = yield* disclosureRunIdAt(
    "admin",
    DateTime.toEpochMillis(yield* DateTime.now)
  )
  // The same words as the other archives' Run now refusal and the badge in
  // components/admin/archive/last-run-card.tsx.
  const refused = () =>
    Effect.fail(new Conflict({ message: "A run is in progress." }))
  // DuplicateRunId: another start in the same millisecond took the id.
  yield* startDisclosureRun(id, "admin").pipe(
    Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused }),
    importingAsConflict
  )
  return { id }
})
