// How the admin page shows a run: its record, judged against its Workflow
// instance's status. The last run card and the recent runs table both use
// `viewRun`, so a run reads the same in both.
import { Effect, Schema } from "effect"

import { type InstanceStatus, RunStatus } from "./archive-workflow.ts"
import { RETENTION_MS } from "./retention.ts"
import { ArchiveRunResult } from "./run-result.ts"

export const RunView = Schema.Struct({
  // The run's record; a run that ended without its summary shows as failed.
  result: ArchiveRunResult,
  inProgress: Schema.Boolean,
  // The instance's status while the record says running, when it has one.
  workflowStatus: Schema.NullOr(RunStatus),
})
export type RunView = typeof RunView.Type

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

// In progress while its instance is queued, running or waiting. With no
// instance, the record decides while the instance could still be retained:
// a record still running past that never ended in a summary.
export const isInProgress = Effect.fnUntraced(function* (
  result: ArchiveRunResult | undefined,
  instance: InstanceStatus | undefined,
  now: number
) {
  return instance !== undefined
    ? IN_PROGRESS.has(instance.status)
    : result?.outcome === "running" &&
        now - Date.parse(result.startedAt) < RETENTION_MS
})

// Why a run whose record still says running has ended, or undefined while
// it hasn't.
const endedUnsummarized = Effect.fnUntraced(function* (
  instance: InstanceStatus | undefined
) {
  if (instance === undefined)
    return "The archive run's Workflow is gone, and it never recorded how the run ended."
  const ended = ENDED_UNSUMMARIZED[instance.status]
  return ended === undefined ? undefined : (instance.error ?? ended)
})

export const viewRun = Effect.fnUntraced(function* (
  result: ArchiveRunResult,
  instance: InstanceStatus | undefined,
  now: number
) {
  const inProgress = yield* isInProgress(result, instance, now)
  const error =
    result.outcome !== "running" || inProgress
      ? undefined
      : yield* endedUnsummarized(instance)
  return RunView.make({
    result:
      error === undefined ? result : { ...result, outcome: "failed", error },
    inProgress,
    workflowStatus:
      result.outcome === "running" && instance !== undefined
        ? instance.status
        : null,
  })
})
