import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger } from "effect"

import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  Unauthorized,
  WorkerEnv,
  makeRunServerEffect,
} from "@workspace/server"

const fakeEnv = Layer.succeed(WorkerEnv, { DEPLOY_PROBE_SECRET: "abc" })

function capturingBridge() {
  const logged: Array<{ level: string; hasCause: boolean }> = []
  const capture = Logger.make(({ logLevel, cause }) => {
    logged.push({ level: logLevel, hasCause: cause.reasons.length > 0 })
  })
  const run = makeRunServerEffect({
    isolate: Logger.layer([capture]),
    workerEnv: fakeEnv,
  })
  return { run, logged }
}

// The Response or redirect runServerEffect throws for a failed program.
const thrown = (promise: Promise<unknown>) =>
  Effect.flip(Effect.tryPromise({ try: () => promise, catch: (e) => e }))

describe("runServerEffect", () => {
  it.effect("returns the program's value, read from WorkerEnv", () =>
    Effect.gen(function* () {
      const { run } = capturingBridge()
      const value = yield* Effect.promise(() =>
        run(WorkerEnv.use((env) => Effect.succeed(env.DEPLOY_PROBE_SECRET)))
      )
      assert.strictEqual(value, "abc")
    })
  )

  it.effect.each([
    [new NotFound({ message: "no quote" }), 404, "NotFound"],
    [new BadRequest({ message: "bad ticker" }), 400, "BadRequest"],
    [new Forbidden({ message: "not yours" }), 403, "Forbidden"],
    [new Conflict({ message: "already exists" }), 409, "Conflict"],
  ] as const)("answers %s with its status", ([error, status, tag]) =>
    Effect.gen(function* () {
      const { run, logged } = capturingBridge()
      const response = yield* thrown(run(Effect.fail(error)))
      assert.instanceOf(response, Response)
      assert.strictEqual(response.status, status)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        error: tag,
        message: error.message,
      })
      assert.deepStrictEqual(logged, [])
    })
  )

  it.effect("redirects Unauthorized to its target", () =>
    Effect.gen(function* () {
      const { run } = capturingBridge()
      const response = yield* thrown(
        run(Effect.fail(new Unauthorized({ redirectTo: "/login" })))
      )
      assert.instanceOf(response, Response)
      assert.strictEqual(response.status, 307)
      assert.strictEqual(response.headers.get("location"), "/login")
    })
  )

  it.effect("logs any other failure and answers a bare 500", () =>
    Effect.gen(function* () {
      const { run, logged } = capturingBridge()
      const response = yield* thrown(
        run(Effect.fail({ secret: "database password in an error" }))
      )
      assert.instanceOf(response, Response)
      assert.strictEqual(response.status, 500)
      const body = yield* Effect.promise(() => response.text())
      assert.notInclude(body, "database password")
      assert.deepStrictEqual(logged, [{ level: "Error", hasCause: true }])
    })
  )

  it.effect("logs a defect and answers a bare 500", () =>
    Effect.gen(function* () {
      const { run, logged } = capturingBridge()
      const response = yield* thrown(run(Effect.die(new Error("boom"))))
      assert.instanceOf(response, Response)
      assert.strictEqual(response.status, 500)
      assert.deepStrictEqual(logged, [{ level: "Error", hasCause: true }])
    })
  )

  it.effect("builds the per-isolate layer once across calls", () =>
    Effect.gen(function* () {
      class Builds extends Context.Service<Builds, { readonly n: number }>()(
        "test/Builds"
      ) {}
      let built = 0
      const run = makeRunServerEffect({
        isolate: Layer.sync(Builds, () => ({ n: ++built })),
        workerEnv: fakeEnv,
      })
      const program = Builds.use((b) => Effect.succeed(b.n))
      assert.strictEqual(yield* Effect.promise(() => run(program)), 1)
      assert.strictEqual(yield* Effect.promise(() => run(program)), 1)
      assert.strictEqual(built, 1)
    })
  )
})
