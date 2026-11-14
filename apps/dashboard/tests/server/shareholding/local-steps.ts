// Runs an archive run's steps in-process, the way the Workflow runtime does:
// each step gets the layer afresh, a failure is retried as often as a step's
// default (5 times, here without the delay) unless it is `NonRetryable`, the
// step's error keeps only its message, and its result goes through JSON, so a
// step that returns something a Workflow can't persist, or more than
// STEP_RESULT_BYTES of it, fails here too.
import {
  NonRetryable,
  STEP_RESULT_BYTES,
  StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { Cause, Effect, type Layer } from "effect"

export const localSteps = <R>(layer: Layer.Layer<R>): WorkflowSteps<R> => ({
  do: (name, effect) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.retry({
        times: 5,
        while: (error) => !(error instanceof NonRetryable),
      }),
      Effect.flatMap((value) => {
        const json = JSON.stringify(value)
        const bytes = new TextEncoder().encode(json).length
        return bytes > STEP_RESULT_BYTES
          ? Effect.die(
              new Error(
                `Step ${name}'s result is ${bytes} bytes, over ${STEP_RESULT_BYTES}`
              )
            )
          : Effect.succeed(JSON.parse(json))
      }),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.fail(
          new StepFailed({
            step: name,
            message: error instanceof Error ? error.message : String(error),
          })
        )
      })
    ),
})
