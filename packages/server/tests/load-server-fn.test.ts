import { isRedirect } from "@tanstack/react-router"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Logger, Schema } from "effect"

import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  Unauthorized,
  WorkerEnv,
  makeRunServerEffect,
} from "@workspace/server"
import {
  LoaderError,
  loadServerFn,
  loaderErrorAdapter,
} from "@workspace/server/loader"

// The real bridge, so each case loads exactly what a server function throws.
const runServerEffect = makeRunServerEffect({
  isolate: Logger.layer([]),
  workerEnv: Layer.succeed(WorkerEnv, { DEPLOY_PROBE_SECRET: "abc" }),
})

const serverFn =
  <A, E>(program: Effect.Effect<A, E, WorkerEnv>) =>
  () =>
    runServerEffect(program)

// The defect a loader rethrows unchanged for the router.
const defectOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    assert.isTrue(Exit.isFailure(exit))
    if (Exit.isSuccess(exit)) return undefined
    assert.isFalse(Cause.hasFails(exit.cause))
    return Cause.squash(exit.cause)
  })

describe("loadServerFn", () => {
  it.effect("returns the server function's value", () =>
    Effect.gen(function* () {
      const value = yield* loadServerFn(serverFn(Effect.succeed(42)))
      assert.strictEqual(value, 42)
    })
  )

  it.effect.each([
    new NotFound({ message: "no such stock" }),
    new BadRequest({ message: "bad code" }),
    new Forbidden({ message: "not yours" }),
    new Conflict({ message: "already there" }),
  ])("decodes a $_tag into that error", (error) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        loadServerFn(serverFn(Effect.fail(error)))
      )
      assert.isTrue(Schema.is(LoaderError)(failure))
      assert.strictEqual(failure._tag, error._tag)
      assert.strictEqual(failure.message, error.message)
    })
  )

  it.effect("passes an Unauthorized redirect through for the router", () =>
    Effect.gen(function* () {
      const defect = yield* defectOf(
        loadServerFn(
          serverFn(Effect.fail(new Unauthorized({ redirectTo: "/login" })))
        )
      )
      assert.isTrue(isRedirect(defect))
    })
  )

  it.effect("treats a 500 as unexpected, keeping the Response", () =>
    Effect.gen(function* () {
      const defect = yield* defectOf(loadServerFn(serverFn(Effect.die("boom"))))
      assert.instanceOf(defect, Response)
      assert.strictEqual((defect as Response).status, 500)
    })
  )

  it.effect("treats a network failure as unexpected, unchanged", () =>
    Effect.gen(function* () {
      const offline = new TypeError("Failed to fetch")
      const defect = yield* defectOf(
        loadServerFn(() => Effect.runPromise(Effect.fail(offline)))
      )
      assert.strictEqual(defect, offline)
    })
  )
})

describe("loaderErrorAdapter", () => {
  it("brings a loader error back as that error after SSR dehydration", () => {
    const error = new Forbidden({ message: "not yours" })
    assert.isTrue(loaderErrorAdapter.test(error))
    const revived = loaderErrorAdapter.fromSerializable(
      JSON.parse(JSON.stringify(loaderErrorAdapter.toSerializable(error)))
    )
    assert.instanceOf(revived, Forbidden)
    assert.strictEqual(revived.message, "not yours")
  })

  it("leaves other errors to the router's own serializer", () => {
    assert.isFalse(loaderErrorAdapter.test(new Error("boom")))
    assert.isFalse(
      loaderErrorAdapter.test(new Unauthorized({ redirectTo: "/login" }))
    )
  })
})
