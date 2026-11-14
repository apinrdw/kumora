// Starting an archive run, from the cron's `scheduled` handler (src/worker.ts)
// or from the admin page's Run now. Spec apinrdw/kumora#303, "Starting a run".
import { Effect, Option, Schema } from "effect"

import { ArchiveBucket } from "./bucket.ts"
import { ArchiveWorkflow, type RunStatus } from "./archive-workflow.ts"
import { LATEST_RUN_KEY } from "./keys.ts"
import { type ArchiveTrigger, LatestRun } from "./run-result.ts"

// The archive cron (UTC): 13:00 and 20:00 WIB. alchemy.run.ts sets it on
// Production only.
export const ARCHIVE_CRON = "0 6,13 * * *"

// Statuses of a run that hasn't ended. `waiting` covers a step's retry
// backoff, so a run between retries still holds off the next one.
const IN_PROGRESS: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "waiting",
])

const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LatestRun)
)

// The id of the run runs/latest.json names, while that run is still in
// progress. Both the cron and Run now check it before starting a run.
export const runInProgress = Effect.gen(function* () {
  const latest = yield* (yield* ArchiveBucket).get(LATEST_RUN_KEY)
  if (latest === undefined) return Option.none<string>()
  const { id } = yield* decodeLatestRun(latest)
  const status = yield* (yield* ArchiveWorkflow).status(id)
  return status !== undefined && IN_PROGRESS.has(status)
    ? Option.some(id)
    : Option.none<string>()
})

// Creates the run's Workflow instance, kept readable for 30 days.
export const startRun = Effect.fnUntraced(function* (
  id: string,
  trigger: ArchiveTrigger
) {
  const workflow = yield* ArchiveWorkflow
  yield* workflow.create({
    id,
    params: { trigger },
    retention: { successRetention: "30 days", errorRetention: "30 days" },
  })
})

// The `scheduled` handler's body: one run per firing, named after its
// scheduled hour (UTC), unless a run is still in progress.
export const scheduledArchiveRun = Effect.fn("scheduledArchiveRun")(function* (
  scheduledTime: number
) {
  const id = `cron-${new Date(scheduledTime).toISOString().slice(0, 13)}`
  const inProgress = yield* runInProgress
  if (Option.isSome(inProgress))
    return yield* Effect.logInfo(
      `Archive run ${id} skipped: ${inProgress.value} is in progress`
    )
  // A second firing for the same hour (a retried invocation) finds the id
  // taken.
  yield* startRun(id, "cron").pipe(
    Effect.catchTag("DuplicateRunId", () =>
      Effect.logInfo(`Archive run ${id} already started`)
    )
  )
})
