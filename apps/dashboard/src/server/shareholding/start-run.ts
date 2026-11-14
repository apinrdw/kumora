// Starting an archive run, from the cron's `scheduled` handler (src/worker.ts)
// or from the admin page's Run now, and the last run both check first. Spec
// apinrdw/kumora#303, "Starting a run".
import { DateTime, Effect, Option, Schema } from "effect"

import {
  ArchiveWorkflow,
  type InstanceStatus,
  type RunStatus,
} from "./archive-workflow.ts"
import { ArchiveBucket } from "./bucket.ts"
import { LATEST_RUN_KEY, runKey } from "./keys.ts"
import {
  ArchiveRunResult,
  type ArchiveTrigger,
  LatestRun,
  runningResult,
} from "./run-result.ts"

// The archive cron (UTC): 13:00 and 20:00 WIB. alchemy.run.ts sets it on
// Production only.
export const ARCHIVE_CRON = "0 6,13 * * *"

// How long Cloudflare keeps a run's instance, ended well or not.
const RETENTION = {
  successRetention: "30 days",
  errorRetention: "30 days",
} as const
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Statuses of a run that hasn't ended. `waiting` covers a step's retry
// backoff, so a run between retries still holds off the next one.
const IN_PROGRESS: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "waiting",
])

// A run that ended before its summary step rewrote its record.
const ENDED_UNSUMMARIZED: Partial<Record<RunStatus, string>> = {
  errored: "The archive run's Workflow errored.",
  terminated: "The archive run's Workflow was terminated.",
}

const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LatestRun)
)
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArchiveRunResult)
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
    result: record === undefined ? undefined : yield* decodeResult(record),
    instance: yield* (yield* ArchiveWorkflow).status(id),
    now: DateTime.toEpochMillis(yield* DateTime.now),
  }
})

type Latest = NonNullable<Effect.Success<typeof readLatest>>

// In progress while its instance is queued, running or waiting. With no
// instance, the record decides while the instance could still be retained:
// a record still running past that never ended in a summary.
const inProgress = ({ result, instance, now }: Latest) =>
  instance !== undefined
    ? IN_PROGRESS.has(instance.status)
    : result?.outcome === "running" &&
      now - Date.parse(result.startedAt) < RETENTION_MS

// The id of the run runs/latest.json names, while that run is still in
// progress. Both the cron and Run now check it before starting a run.
export const runInProgress = Effect.map(readLatest, (latest) =>
  latest !== undefined && inProgress(latest)
    ? Option.some(latest.id)
    : Option.none<string>()
)

export interface LastRun {
  // The run's record; a run that ended without its summary shows as failed.
  readonly result: ArchiveRunResult
  readonly inProgress: boolean
  // The instance's status while the record says running, when it has one.
  readonly live: RunStatus | null
}

const endedUnsummarized = (
  result: ArchiveRunResult,
  instance: InstanceStatus | undefined,
  running: boolean
): string | undefined => {
  if (result.outcome !== "running" || running) return undefined
  if (instance === undefined)
    return "The archive run's Workflow is gone, and it never recorded how the run ended."
  return ENDED_UNSUMMARIZED[instance.status]
    ? (instance.error ?? ENDED_UNSUMMARIZED[instance.status])
    : undefined
}

// The last run, for the admin page: undefined before any run.
export const lastRun = Effect.map(readLatest, (latest): LastRun | undefined => {
  if (latest?.result === undefined) return undefined
  const { result, instance } = latest
  const running = inProgress(latest)
  const error = endedUnsummarized(result, instance, running)
  return {
    result:
      error === undefined ? result : { ...result, outcome: "failed", error },
    inProgress: running,
    live:
      result.outcome === "running" && instance !== undefined
        ? instance.status
        : null,
  }
})

// Creates the run's Workflow instance, kept readable for 30 days, then
// points runs/latest.json at it with a `running` record.
// Decision: the start writes the pointer and record, not only the run's
// `plan` step, so the run is in progress from the moment it exists: a second
// start before `plan` runs is refused too. `plan` writes both again.
export const startRun = Effect.fnUntraced(function* (
  id: string,
  trigger: ArchiveTrigger
) {
  const workflow = yield* ArchiveWorkflow
  yield* workflow.create({ id, params: { trigger }, retention: RETENTION })
  const bucket = yield* ArchiveBucket
  const record = yield* runningResult({
    id,
    trigger,
    startedAt: DateTime.formatIso(yield* DateTime.now),
  })
  for (const [key, value] of [
    [yield* runKey(id), record],
    [LATEST_RUN_KEY, { id }],
  ] as const)
    yield* bucket.put(key, JSON.stringify(value), {
      contentType: "application/json",
    })
})

// The `scheduled` handler's body: one run per firing, named after its
// scheduled hour (UTC), unless a run is still in progress.
export const scheduledArchiveRun = Effect.fn("scheduledArchiveRun")(function* (
  scheduledTime: number
) {
  const id = `cron-${new Date(scheduledTime).toISOString().slice(0, 13)}`
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
