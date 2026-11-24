// How an admin page shows a run: its record, judged against its Workflow
// instance's status. The last run card and the recent runs table both use
// `viewRun`, so a run reads the same in both.
import { Effect } from "effect"

import type { RunBase } from "./run.ts"
import type { InstanceStatus, RunStatus } from "./workflow.ts"

export interface RunView<RunRecord extends RunBase> {
  // The run's record; a run that ended without its summary shows as failed.
  readonly result: RunRecord
  readonly inProgress: boolean
  // The instance's status while the record says running, when it has one.
  readonly workflowStatus: RunStatus | null
}

// What judging a run reads of its record.
type RunState = Pick<RunBase, "outcome" | "startedAt">

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

// How long a start may take between claiming its run's row and its
// `create` returning: the call to Workflows.
const START_WINDOW_MS = 5 * 60 * 1000

// In progress until its instance has ended. With no
// instance, a record still running is a start not yet through `create`, for
// START_WINDOW_MS; past that, its start died before the instance existed, or
// the instance outlived its retention.
export const isInProgress = Effect.fnUntraced(function* (
  result: RunState | undefined,
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

// Why a run whose record still says running has ended, or undefined while
// its record stands. The recent runs table shows such a run as failed.
export const endedRunError = Effect.fnUntraced(function* (
  run: RunState,
  instance: InstanceStatus | undefined,
  now: number
) {
  return run.outcome !== "running" || (yield* isInProgress(run, instance, now))
    ? undefined
    : yield* endedUnsummarized(instance)
})

export const viewRun = <RunRecord extends RunBase>(
  result: RunRecord,
  instance: InstanceStatus | undefined,
  now: number
): Effect.Effect<RunView<RunRecord>> =>
  Effect.gen(function* () {
    const inProgress = yield* isInProgress(result, instance, now)
    const error = yield* endedRunError(result, instance, now)
    return {
      result:
        error === undefined ? result : { ...result, outcome: "failed", error },
      inProgress,
      workflowStatus:
        result.outcome === "running" && instance !== undefined
          ? instance.status
          : null,
    }
  })
