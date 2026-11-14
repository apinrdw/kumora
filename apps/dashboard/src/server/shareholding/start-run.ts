// Starting an archive run, from the cron's `scheduled` handler (src/worker.ts)
// or from the admin page's Run now, and the last run the page shows. Spec
// apinrdw/kumora#303, "Starting a run".
import { DateTime, Effect, Schema } from "effect"

import { ArchiveWorkflow, DuplicateRunId } from "./archive-workflow.ts"
import { ArchiveBucket, putRunRecord } from "./bucket.ts"
import { LATEST_RUN_KEY, runKey } from "./keys.ts"
import { RETENTION } from "./retention.ts"
import {
  ArchiveRunResult,
  ArchiveRunId,
  type ArchiveTrigger,
  decodeRunResult,
  LatestRun,
  runIdAt,
  runningResult,
} from "./run-result.ts"
import { isInProgress, START_WINDOW_MS, viewRun } from "./run-view.ts"

// The run runs/latest.json names is still in progress.
class RunInProgress extends Schema.TaggedError<RunInProgress>()(
  "RunInProgress",
  { id: ArchiveRunId }
) {}

const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LatestRun)
)

// The run runs/latest.json names: its record, its instance's status, and
// the pointer's ETag, which a start that claims it must still find.
const readLatest = Effect.gen(function* () {
  const bucket = yield* ArchiveBucket
  const pointer = yield* bucket.get(LATEST_RUN_KEY)
  if (pointer === undefined) return undefined
  const { id } = yield* decodeLatestRun(pointer.body)
  const record = yield* bucket.get(yield* runKey(id))
  const result =
    record === undefined ? undefined : yield* decodeRunResult(record.body)
  const instance = yield* (yield* ArchiveWorkflow).status(id)
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  return {
    id,
    etag: pointer.etag,
    result,
    instance,
    now,
    // With neither a record nor an instance, a start has just claimed the
    // pointer and is still writing them.
    inProgress:
      result === undefined && instance === undefined
        ? now - pointer.uploaded.getTime() < START_WINDOW_MS
        : yield* isInProgress(result, instance, now),
  }
})

// The last run, for the admin page: undefined before any run.
export const lastRun = Effect.gen(function* () {
  const latest = yield* readLatest
  if (latest?.result === undefined) return undefined
  return yield* viewRun(latest.result, latest.instance, latest.now)
})

// Points runs/latest.json at `id`, unless the run it names is in progress or
// `id` ran before. Only a start writes the pointer: no step of a run does.
// Decision: the pointer is the one claim on starting a run, for the cron and
// Run now alike, written in one conditional R2 write only while its ETag is
// the one this start judged. Of two starts that read the same pointer, one
// claims it and the other judges again against the winner. See
// apinrdw/kumora#309.
const claim: (
  id: ArchiveRunId
) => Effect.Effect<
  void,
  RunInProgress | DuplicateRunId | Effect.Error<typeof readLatest>,
  Effect.Services<typeof readLatest>
> = Effect.fnUntraced(function* (id) {
  const latest = yield* readLatest
  if (latest?.id === id) return yield* new DuplicateRunId({ id })
  if (latest?.inProgress) return yield* new RunInProgress({ id: latest.id })
  const bucket = yield* ArchiveBucket
  // A start claiming the same id claims from this same pointer, so only one
  // gets past the write below.
  if (yield* bucket.exists(yield* runKey(id)))
    return yield* new DuplicateRunId({ id })
  const claimed = yield* bucket.putIfUnchanged(
    LATEST_RUN_KEY,
    JSON.stringify(LatestRun.make({ id })),
    { contentType: "application/json" },
    latest?.etag
  )
  if (!claimed) return yield* claim(id)
})

// Claims the start, then creates the run's Workflow instance, kept for
// RETENTION, with a `running` record.
// Decision: the record is written before `create`: after `create`, the run's
// own steps may already have ended it, and writing `running` then would
// never be undone (apinrdw/kumora#309).
export const startRun = Effect.fnUntraced(function* (
  id: ArchiveRunId,
  trigger: ArchiveTrigger
) {
  yield* claim(id)
  const record = yield* runningResult({
    id,
    trigger,
    startedAt: DateTime.toDateUtc(yield* DateTime.now),
  })
  yield* putRunRecord(record)
  yield* (yield* ArchiveWorkflow)
    .create({ id, params: { trigger }, retention: RETENTION })
    .pipe(
      // No instance will ever rewrite this record: end it here, so it
      // doesn't hold off runs as in progress.
      Effect.tapError((error) =>
        error._tag === "WorkflowError"
          ? Effect.gen(function* () {
              yield* Effect.logError(
                "The archive Workflow refused a run",
                error
              )
              yield* putRunRecord(
                ArchiveRunResult.make({
                  ...record,
                  finishedAt: DateTime.formatIso(yield* DateTime.now),
                  outcome: "failed",
                  error: "The Workflow refused to start the run.",
                })
              )
            })
          : Effect.void
      )
    )
})

// What each cron firing runs (`runArchiveCron`, cron.ts): one run per firing,
// named after its scheduled hour (UTC), unless a run is still in progress.
export const scheduledArchiveRun = Effect.fn("scheduledArchiveRun")(function* (
  scheduledTime: number
) {
  const id = yield* runIdAt("cron", scheduledTime)
  yield* startRun(id, "cron").pipe(
    Effect.catchTags({
      RunInProgress: ({ id: running }) =>
        Effect.logInfo(`Archive run ${id} skipped: ${running} is in progress`),
      // A second firing for the same hour (a retried invocation).
      DuplicateRunId: () => Effect.logInfo(`Archive run ${id} already started`),
    })
  )
})
