// Starting an archive run, from the cron's `scheduled` handler (src/worker.ts)
// or from the admin page's Run now, and the last run both check first. Spec
// apinrdw/kumora#303, "Starting a run".
import { DateTime, Effect, Option, Schema } from "effect"

import { ArchiveWorkflow } from "./archive-workflow.ts"
import { ArchiveBucket, putJson } from "./bucket.ts"
import { LATEST_RUN_KEY, runKey } from "./keys.ts"
import { RETENTION } from "./retention.ts"
import {
  ArchiveRunResult,
  ArchiveRunId,
  type ArchiveTrigger,
  decodeRunResult,
  LatestRun,
  runningResult,
} from "./run-result.ts"
import { isInProgress, viewRun } from "./run-view.ts"

const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LatestRun)
)

// The run runs/latest.json names: its record and its instance's status.
const readLatest = Effect.gen(function* () {
  const bucket = yield* ArchiveBucket
  const latest = yield* bucket.get(LATEST_RUN_KEY)
  if (latest === undefined) return undefined
  const { id } = yield* decodeLatestRun(latest)
  const record = yield* bucket.get(yield* runKey(id))
  return {
    id,
    result: record === undefined ? undefined : yield* decodeRunResult(record),
    instance: yield* (yield* ArchiveWorkflow).status(id),
    now: DateTime.toEpochMillis(yield* DateTime.now),
  }
})

// The id of the run runs/latest.json names, while that run is still in
// progress. Both the cron and Run now check it before starting a run.
export const runInProgress = Effect.gen(function* () {
  const latest = yield* readLatest
  return latest !== undefined &&
    (yield* isInProgress(latest.result, latest.instance, latest.now))
    ? Option.some(latest.id)
    : Option.none<ArchiveRunId>()
})

// The last run, for the admin page: undefined before any run.
export const lastRun = Effect.gen(function* () {
  const latest = yield* readLatest
  if (latest?.result === undefined) return undefined
  return yield* viewRun(latest.result, latest.instance, latest.now)
})

// Creates the run's Workflow instance, kept for RETENTION, with a
// `running` record, then points runs/latest.json at it. A second cron firing
// for the same hour finds the record, and its `create` fails before
// latest.json moves.
// Decision: the record is written before `create`, only when the id has none:
// after `create`, the run's own steps may already have ended it, and writing
// `running` then would never be undone. Writing it at all refuses a second
// start before `plan` (apinrdw/kumora#309).
export const startRun = Effect.fnUntraced(function* (
  id: ArchiveRunId,
  trigger: ArchiveTrigger
) {
  const key = yield* runKey(id)
  const recorded = yield* (yield* ArchiveBucket).exists(key)
  const record = yield* runningResult({
    id,
    trigger,
    startedAt: DateTime.toDateUtc(yield* DateTime.now),
  })
  if (!recorded) yield* putJson(key, record)
  yield* (yield* ArchiveWorkflow)
    .create({ id, params: { trigger }, retention: RETENTION })
    .pipe(
      // No instance will ever rewrite this record: end it here, so it
      // doesn't hold off runs as in progress.
      Effect.tapError((error) =>
        error._tag === "WorkflowError" && !recorded
          ? Effect.gen(function* () {
              yield* Effect.logError(
                "The archive Workflow refused a run",
                error
              )
              yield* putJson(
                key,
                ArchiveRunResult.make({
                  ...record,
                  finishedAt: DateTime.formatIso(yield* DateTime.now),
                  outcome: "failed",
                  error: "The Workflow refused to start the run.",
                })
              )
              yield* putJson(LATEST_RUN_KEY, LatestRun.make({ id }))
            })
          : Effect.void
      )
    )
  yield* putJson(LATEST_RUN_KEY, LatestRun.make({ id }))
})

// The `scheduled` handler's body: one run per firing, named after its
// scheduled hour (UTC), unless a run is still in progress.
export const scheduledArchiveRun = Effect.fn("scheduledArchiveRun")(function* (
  scheduledTime: number
) {
  const id = ArchiveRunId.make(
    `cron-${new Date(scheduledTime).toISOString().slice(0, 13)}`
  )
  const running = yield* runInProgress
  if (Option.isSome(running))
    return yield* Effect.logInfo(
      `Archive run ${id} skipped: ${running.value} is in progress`
    )
  // A second firing for the same hour (a retried invocation) finds the id
  // taken.
  yield* startRun(id, "cron").pipe(
    Effect.catchTag("DuplicateRunId", () =>
      Effect.logInfo(`Archive run ${id} already started`)
    )
  )
})
