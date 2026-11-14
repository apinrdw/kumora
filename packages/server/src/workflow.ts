// Decision: the second module that reaches `cloudflare:workers`, besides the
// bridge: a Workflow class must extend WorkflowEntrypoint, so it imports it at
// the top, which the bridge can't (prerender loads the bridge in Bun). Only a
// Worker's entry imports this module, never a route. See apinrdw/kumora#305.
import {
  type WorkflowEvent,
  type WorkflowStep,
  WorkflowEntrypoint,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { Effect, type Layer } from "effect"

import { WorkerEnv, type WorkerEnvShape } from "./bridge.ts"
import { NonRetryable, StepFailed, type WorkflowSteps } from "./steps.ts"

export interface WorkflowRun<Params> {
  readonly id: string
  readonly startedAt: Date
  readonly params: Params
}

// A Workflow class whose run is an Effect over `WorkflowSteps`. Each step
// runs its Effect with `layer` and the Worker's env, rejects with the step's
// failure as is, except `NonRetryable`, thrown as `NonRetryableError` to skip
// the step's retries, and keeps the step's default retries: no Effect retry
// on top.
export const makeWorkflow = <Params, Output, R>(
  layer: Layer.Layer<R, never, WorkerEnv>,
  run: (
    event: WorkflowRun<Params>,
    steps: WorkflowSteps<R>
  ) => Effect.Effect<Output, StepFailed>
) =>
  class extends WorkflowEntrypoint<WorkerEnvShape, Params> {
    override run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
      const env = Effect.provideService(WorkerEnv, this.env)
      const steps: WorkflowSteps<R> = {
        do: <A, E>(name: string, effect: Effect.Effect<A, E, R>) =>
          Effect.tryPromise({
            try: () =>
              // WorkflowSteps asks for plain JSON results, which workers-types
              // can't check against a generic `A`; tests round-trip every
              // step result through JSON (apps/dashboard/tests/server/
              // shareholding/local-steps.ts).
              step.do(
                name,
                () =>
                  Effect.runPromise(
                    effect.pipe(
                      Effect.provide(layer),
                      env,
                      Effect.mapError((error) =>
                        error instanceof NonRetryable
                          ? new NonRetryableError(error.message)
                          : error
                      )
                    )
                  ) as Promise<Rpc.Serializable<A>>
              ) as Promise<A>,
            catch: (cause) =>
              new StepFailed({
                step: name,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
      }
      return Effect.runPromise(
        run(
          {
            id: event.instanceId,
            startedAt: event.timestamp,
            params: event.payload as Params,
          },
          steps
        )
      )
    }
  }
