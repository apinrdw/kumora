// Runs an archive run's steps in-process, the way the Workflow runtime does:
// each step gets the layer afresh, and its result goes through JSON, so a
// step that returns something a Workflow can't persist fails here too.
import { StepFailed, type WorkflowSteps } from "@workspace/server"
import { Cause, Effect, type Layer } from "effect"

export const localSteps = <R>(layer: Layer.Layer<R>): WorkflowSteps<R> => ({
  do: (name, effect) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.map((value) => JSON.parse(JSON.stringify(value))),
      Effect.catchCause((cause) =>
        Effect.fail(
          new StepFailed({ step: name, message: Cause.pretty(cause) })
        )
      )
    ),
})
