import { afterEach, assert, describe, it } from "@effect/vitest"
import type { Layer } from "effect"
import { Effect, Logger } from "effect"
import { vi } from "vitest"

import {
  MAX_STEP_NAME_LENGTH,
  NonRetryable,
  StepFailed,
  type WorkflowSteps,
} from "@workspace/server"

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

// Runs a Workflow whose run is `body`, with each step run at once. `ran`
// logs the name of every step the runtime was asked to run, `configs` the
// config each was given.
const runWorkflow = (
  layer: Layer.Layer<never>,
  body: (steps: WorkflowSteps<never>) => Effect.Effect<unknown, StepFailed>
) => {
  const ran: Array<string> = []
  const configs: Array<unknown> = []
  const Workflow = makeWorkflow(layer, (_, steps) =>
    body(steps).pipe(Effect.asVoid)
  )
  const workflow = new Workflow({} as never, {} as never)
  const result = Effect.tryPromise({
    try: () =>
      workflow.run(
        {
          instanceId: "run-1",
          timestamp: new Date(0),
          payload: {},
        } as never,
        {
          do: (
            name: string,
            config: unknown,
            callback: () => Promise<unknown>
          ) => {
            ran.push(name)
            configs.push(config)
            return callback()
          },
        } as never
      ),
    catch: (error) => error,
  })
  return { ran, configs, result }
}

const runOneStep = (
  layer: Layer.Layer<never>,
  body: Effect.Effect<unknown, unknown>
) => runWorkflow(layer, (steps) => steps.do("only", body)).result

// The error a run rejects with. A run that resolves fails the test.
const rejection = (result: Effect.Effect<void, unknown>) =>
  result.pipe(
    Effect.flatMap(() =>
      Effect.sync(() =>
        assert.fail("expected the run to reject, but it resolved")
      )
    ),
    Effect.flip
  )

// The runtime's own logger, which the run outside any step logs through,
// writes to the console.
const consoleLog = () => vi.spyOn(console, "log").mockImplementation(() => {})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it.effect("logs a defect in the run itself", () =>
    Effect.gen(function* () {
      const { layer } = capturing()
      const log = consoleLog()
      yield* rejection(
        runWorkflow(layer, () => Effect.die(new Error("kaput"))).result
      )
      assert.include(log.mock.calls.flat(), "Workflow run died")
    })
  )

  it.effect("runs a step whose name takes the most characters", () =>
    Effect.gen(function* () {
      const { layer } = capturing()
      const name = "n".repeat(MAX_STEP_NAME_LENGTH)
      const { ran, result } = runWorkflow(layer, (steps) =>
        steps.do(name, Effect.succeed(1))
      )
      yield* result
      assert.deepStrictEqual(ran, [name])
    })
  )

  it.effect("gives the runtime each step's own config", () =>
    Effect.gen(function* () {
      const { layer } = capturing()
      const { configs, result } = runWorkflow(layer, (steps) =>
        Effect.andThen(
          steps.do("timed", Effect.succeed(1), { timeout: "2 minutes" }),
          steps.do("default", Effect.succeed(2))
        )
      )
      yield* result
      assert.deepStrictEqual(configs, [{ timeout: "2 minutes" }, {}])
    })
  )

  it.effect(
    "dies on a step name past the most characters, running nothing",
    () =>
      Effect.gen(function* () {
        const { layer } = capturing()
        consoleLog()
        const name = "n".repeat(MAX_STEP_NAME_LENGTH + 1)
        const { ran, result } = runWorkflow(layer, (steps) =>
          steps.do(name, Effect.succeed(1))
        )
        const error = yield* rejection(result)
        assert.include(
          String(error),
          `is ${MAX_STEP_NAME_LENGTH + 1} characters, over ${MAX_STEP_NAME_LENGTH}`
        )
        assert.deepStrictEqual(ran, [])
      })
  )
})
