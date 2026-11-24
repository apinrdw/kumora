// An admin page's view of an archive's runs over time: the runs of the past
// 30 days (spec apinrdw/kumora#303, "The admin page").
import { Clock, Effect } from "effect"

import { RETENTION_MS } from "./retention.ts"
import { type RunBase, type ArchiveSource, type RunSummaryBase } from "./run.ts"
import { readRuns } from "./run-import.ts"
import { decodeRuns, recentRunsStatement } from "./run-rows.ts"
import { endedRunError } from "./run-view.ts"
import { ArchiveWorkflow, type WorkflowError } from "./workflow.ts"

// The runs started in the past 30 days, newest first, each shown as the last
// run card shows it, from their rows' summaries.
export const listRecentRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const workflow = yield* ArchiveWorkflow
    const now = yield* Clock.currentTimeMillis
    const [rows = []] = yield* readRuns(source, [
      recentRunsStatement(source, now - RETENTION_MS),
    ])
    const recent = yield* decodeRuns(source.summary, rows)
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
