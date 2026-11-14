import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { kseiHttp } from "@/server/ksei/http"

// A KSEI that never answers, until the request is aborted.
const silentFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
  Effect.runPromise(
    Effect.callback<Response, unknown>((resume) =>
      init?.signal?.addEventListener("abort", () =>
        resume(Effect.fail(init.signal?.reason))
      )
    )
  )) as typeof globalThis.fetch

const URL_ =
  "https://www.ksei.co.id/storage/Download/StatisEfek20261030.txt.zip"

describe("a request to KSEI", () => {
  it.effect("fails when KSEI hasn't answered it in 2 minutes", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          return yield* (yield* HttpClient.HttpClient).head(URL_)
        }).pipe(
          Effect.provide(
            kseiHttp.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, silentFetch))
            )
          )
        )
      )
      yield* TestClock.adjust("119 seconds")
      assert.isUndefined(fiber.pollUnsafe(), "still waiting at 119 seconds")
      yield* TestClock.adjust("1 second")
      // The aborted fetch settles on the next turn of the event loop.
      yield* Effect.callback<void>((resume) => {
        setTimeout(() => resume(Effect.void))
      })
      const exit = fiber.pollUnsafe()
      assert.isTrue(
        exit !== undefined && Exit.isFailure(exit),
        "failed at 2 minutes"
      )
      yield* Fiber.interrupt(fiber)
    })
  )
})
