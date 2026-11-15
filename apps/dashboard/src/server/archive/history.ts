// An admin page's view of an archive's runs over time: the runs of the past
// 30 days (spec apinrdw/kumora#303, "The admin page").
import { Clock, Effect, Option, Schema } from "effect"

import { ArchiveBucket } from "./bucket.ts"
import { RETENTION_MS } from "./retention.ts"
import { type RunBase, type ArchiveSource, type RunSummaryBase } from "./run.ts"
import { endedRunError } from "./run-view.ts"
import { ArchiveWorkflow, type WorkflowError } from "./workflow.ts"

// The runs started in the past 30 days, newest first, each shown as the last
// run card shows it. From the summaries the listing of runs/ carries
// (`source.metadata`), so it holds at most MAX_LISTED_OBJECTS of them per
// trigger and reads no record.
// Decision: one listing per trigger, starting after the key of a run that
// trigger would have started 30 days ago. Run ids of one trigger sort as
// their starts do (`runIdAt`), so the page lists only the past 30 days of
// runs, and runs/ can grow without the page listing more of it. See
// apinrdw/kumora#310.
export const listRecentRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const bucket = yield* ArchiveBucket
    const workflow = yield* ArchiveWorkflow
    const now = yield* Clock.currentTimeMillis
    const since = now - RETENTION_MS
    const decodeRunMetadata = Schema.decodeUnknownOption(source.metadata)
    const listings = yield* Effect.forEach(source.triggers, (trigger) =>
      Effect.gen(function* () {
        const oldest = yield* source.runIdAt(trigger, since)
        return yield* bucket.list(`${source.runsPrefix}${trigger}-`, {
          // runs/<id> sorts just before runs/<id>.json, so that run is listed.
          startAfter: `${source.runsPrefix}${oldest}`,
        })
      })
    )
    // A record without the metadata (written before records carried it, in
    // a dev or test bucket only) is left out.
    const runs = listings
      .flat()
      .flatMap(({ customMetadata }) =>
        Option.toArray(decodeRunMetadata(customMetadata))
      )
      .map(({ run }) => run)
    const recent = runs
      .filter((run) => Date.parse(run.startedAt) >= since)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    // Only a record that still says running needs its instance's status.
    return yield* Effect.forEach(
      recent,
      (run): Effect.Effect<Summary, WorkflowError> =>
        Effect.gen(function* () {
          if (run.outcome !== "running") return run
          const instance = yield* workflow.status(run.id)
          const ended = yield* endedRunError(run, instance, now)
          return ended === undefined
            ? run
            : { ...run, outcome: "failed" as const }
        }),
      { concurrency: 10 }
    )
  })
