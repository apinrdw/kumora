import { assert, describe, it } from "@effect/vitest"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isRedirect,
} from "@tanstack/react-router"
import { Cause, Context, Effect, Layer, Logger, Result } from "effect"

import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  Unauthorized,
  WorkerEnv,
  makeRunServerEffect,
  makeRunServerEffectResult,
} from "@workspace/server"

const fakeWorkerEnv = Layer.succeed(WorkerEnv, { DEPLOY_PROBE_SECRET: "abc" })

function capturingLogger() {
  const logged: Array<{ level: string; hasCause: boolean }> = []
  const capture = Logger.make(({ logLevel, cause }) => {
    logged.push({ level: logLevel, hasCause: cause.reasons.length > 0 })
  })
  const bridge = { isolate: Logger.layer([capture]), workerEnv: fakeWorkerEnv }
  return { bridge, logged }
}

function capturingBridge() {
  const { bridge, logged } = capturingLogger()
  return { run: makeRunServerEffect(bridge), logged }
}

function capturingResultBridge() {
  const { bridge, logged } = capturingLogger()
  return { run: makeRunServerEffectResult(bridge), logged }
}

// The Response or redirect runServerEffect throws for a failed program.
const thrown = (promise: Promise<unknown>) =>
  Effect.flip(Effect.tryPromise({ try: () => promise, catch: (e) => e }))

describe("runServerEffect", () => {
  it.effect("returns the program's value, read from WorkerEnv", () =>
    Effect.gen(function* () {
      const { run } = capturingBridge()
      const value = yield* Effect.promise(() =>
        run(
          WorkerEnv.use((workerEnv) =>
            Effect.succeed(workerEnv.DEPLOY_PROBE_SECRET)
          )
        )
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

  it.effect(
    "redirects Unauthorized to its target, under the router's basepath",
    () =>
      Effect.gen(function* () {
        const { run } = capturingBridge()
        const thrownRedirect = yield* thrown(
          run(
            Effect.fail(
              new Unauthorized({
                redirectTo: "/sign-in?redirect=%2Fstocks%2FA",
              })
            )
          )
        )
        assert.isTrue(isRedirect(thrownRedirect))
        if (!isRedirect(thrownRedirect)) return
        const router = createRouter({
          routeTree: createRootRoute(),
          basepath: "/app",
          history: createMemoryHistory(),
        })
        const resolved = router.resolveRedirect(thrownRedirect)
        assert.strictEqual(resolved.status, 307)
        assert.strictEqual(
          resolved.headers.get("location"),
          "/app/sign-in?redirect=%2Fstocks%2FA"
        )
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

  it.effect(
    "logs and answers a bare 500 when an HTTP error fails beside another failure",
    () =>
      Effect.gen(function* () {
        const { run, logged } = capturingBridge()
        const response = yield* thrown(
          run(
            Effect.failCause(
              Cause.combine(
                Cause.fail(new NotFound({ message: "no quote" })),
                Cause.fail({ secret: "database password in an error" })
              )
            )
          )
        )
        assert.instanceOf(response, Response)
        assert.strictEqual(response.status, 500)
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
        workerEnv: fakeWorkerEnv,
      })
      const program = Builds.use((b) => Effect.succeed(b.n))
      assert.strictEqual(yield* Effect.promise(() => run(program)), 1)
      assert.strictEqual(yield* Effect.promise(() => run(program)), 1)
      assert.strictEqual(built, 1)
    })
  )
})

describe("runServerEffectResult", () => {
  it.effect("returns the program's value, read from WorkerEnv", () =>
    Effect.gen(function* () {
      const { run } = capturingResultBridge()
      const result = yield* Effect.promise(() =>
        run(
          WorkerEnv.use((workerEnv) =>
            Effect.succeed(workerEnv.DEPLOY_PROBE_SECRET)
          )
        )
      )
      assert.deepStrictEqual(result, Result.succeed("abc"))
    })
  )

  it.effect.each([
    [new NotFound({ message: "no quote" })],
    [new BadRequest({ message: "bad ticker" })],
    [new Forbidden({ message: "not yours" })],
    [new Conflict({ message: "already exists" })],
    [new Unauthorized({ redirectTo: "/sign-in" })],
  ] as const)("hands back %s as a value", ([error]) =>
    Effect.gen(function* () {
      const { run, logged } = capturingResultBridge()
      const result = yield* Effect.promise(() => run(Effect.fail(error)))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure, error)
      assert.deepStrictEqual(logged, [])
    })
  )

  // The bare 500 runServerEffectResult hands back for a failed program.
  const internalError = (result: Result.Result<unknown, unknown>) => {
    assert.isTrue(Result.isFailure(result))
    const failure = Result.isFailure(result) ? result.failure : undefined
    assert.instanceOf(failure, Response)
    return failure as Response
  }

  it.effect.each([
    [
      "another failure",
      Effect.fail({ secret: "database password in an error" }),
    ],
    [
      "an HTTP error beside another failure",
      Effect.failCause(
        Cause.combine(
          Cause.fail(new NotFound({ message: "no quote" })),
          Cause.fail({ secret: "database password in an error" })
        )
      ),
    ],
    ["a defect", Effect.die(new Error("database password in a defect"))],
  ] as const)("logs %s and hands back a bare 500", ([, program]) =>
    Effect.gen(function* () {
      const { run, logged } = capturingResultBridge()
      const response = internalError(yield* Effect.promise(() => run(program)))
      assert.strictEqual(response.status, 500)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        error: "InternalServerError",
        message: "",
      })
      assert.deepStrictEqual(logged, [{ level: "Error", hasCause: true }])
    })
  )
})
