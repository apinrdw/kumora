// How the admin page shows a run: its record, judged against its Workflow
// instance's status. The last run card and the recent runs table both use
// `viewRun`, so a run reads the same in both.
import { Effect, Schema } from "effect"

import { type InstanceStatus, RunStatus } from "./archive-workflow.ts"
import { ArchiveRunResult } from "./run-result.ts"

const RunView = Schema.Struct({
  // The run's record; a run that ended without its summary shows as failed.
  result: ArchiveRunResult,
  inProgress: Schema.Boolean,
  // The instance's status while the record says running, when it has one.
  workflowStatus: Schema.NullOr(RunStatus),
})
export type RunView = typeof RunView.Type

// Statuses of a run that has ended. Every other status holds off the next
// run: a paused or pausing run can resume, a waiting one is between retries,
// and a status Cloudflare adds later blocks until it is known to end.
const ENDED: ReadonlySet<RunStatus> = new Set([
  "complete",
  "errored",
  "terminated",
])

// A run that ended before its summary step rewrote its record.
const ENDED_UNSUMMARIZED: Partial<Record<RunStatus, string>> = {
  errored: "The archive run's Workflow errored.",
  terminated: "The archive run's Workflow was terminated.",
}

// How long a start may take between claiming runs/latest.json and its
// `create` returning: two R2 writes and the call to Workflows.
export const START_WINDOW_MS = 5 * 60 * 1000

// In progress until its instance has ended. With no
// instance, a record still running is a start not yet through `create`, for
// START_WINDOW_MS; past that, its start died before the instance existed, or
// the instance outlived its retention.
export const isInProgress = Effect.fnUntraced(function* (
  result: ArchiveRunResult | undefined,
  instance: InstanceStatus | undefined,
  now: number
) {
  return instance !== undefined
    ? !ENDED.has(instance.status)
    : result?.outcome === "running" &&
        now - Date.parse(result.startedAt) < START_WINDOW_MS
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
