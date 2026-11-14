import { assert, describe, it } from "@effect/vitest"
import type { Layer } from "effect"
import { Effect, Logger } from "effect"
import { vi } from "vitest"

import { NonRetryable, StepFailed } from "@workspace/server"

// The Workers runtime's modules, as far as the Workflow runner uses them.
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  },
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}))

const { makeWorkflow } = await import("@workspace/server/workflow")

const capturing = () => {
  const logged: Array<{ level: string; hasCause: boolean }> = []
  const layer = Logger.layer([
    Logger.make(({ logLevel, cause }) => {
      logged.push({ level: logLevel, hasCause: cause.reasons.length > 0 })
    }),
  ])
  return { logged, layer }
}

// Runs a one-step Workflow whose step is `body`, with each step run at once.
const runOneStep = (
  layer: Layer.Layer<never>,
  body: Effect.Effect<unknown, unknown>
) => {
  const Workflow = makeWorkflow(layer, (_, steps) =>
    steps.do("only", body).pipe(Effect.asVoid)
  )
  const workflow = new Workflow({} as never, {} as never)
  return Effect.tryPromise({
    try: () =>
      workflow.run(
        {
          instanceId: "run-1",
          timestamp: new Date(0),
          payload: {},
        } as never,
        {
          do: (_: string, callback: () => Promise<unknown>) => callback(),
        } as never
      ),
    catch: (error) => error,
  })
}

describe("the Workflow runner", () => {
  it.effect("logs a step's defect, as the bridge logs a request's", () =>
    Effect.gen(function* () {
      const { logged, layer } = capturing()
      const failure = yield* Effect.flip(
        runOneStep(layer, Effect.die(new Error("kaput")))
      )
      assert.instanceOf(failure, StepFailed)
      assert.deepInclude(logged, { level: "Error", hasCause: true })
    })
  )

  it.effect("logs a step's failure", () =>
    Effect.gen(function* () {
      const { logged, layer } = capturing()
      yield* Effect.flip(
        runOneStep(layer, Effect.fail(new NonRetryable({ message: "gone" })))
      )
      assert.deepInclude(logged, { level: "Error", hasCause: true })
    })
  )

  it.effect("logs nothing for a step that succeeds", () =>
    Effect.gen(function* () {
      const { logged, layer } = capturing()
      yield* runOneStep(layer, Effect.succeed(1))
      assert.deepStrictEqual(logged, [])
    })
  )
})
