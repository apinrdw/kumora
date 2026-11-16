// A run's step whose failure fails the whole run, for every archive's runs.
// Kept apart from run.ts, which the e2e seeders load without the Workers
// types @workspace/server needs.
import type { StepFailed, WorkflowSteps } from "@workspace/server"
import { Effect } from "effect"

// `step`, a run's step whose failure fails the run: on failure, a `failed`
// step writes the run's record with `record`. The run still fails with the
// step's message, which the Workflow keeps as the instance's error.
export const failingRun = <A, R>(
  steps: WorkflowSteps<R>,
  step: Effect.Effect<A, StepFailed>,
  record: (message: string) => Effect.Effect<unknown, unknown, R>
) =>
  step.pipe(
    Effect.tapError(({ message }) =>
      steps.do("failed", record(message)).pipe(Effect.ignore({ log: "Warn" }))
    )
  )
