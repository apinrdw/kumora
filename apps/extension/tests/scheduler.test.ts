import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Effect, Fiber } from "effect"

import { relayScheduler } from "../src/worker/scheduler.ts"

const YIELDS = 1000

describe("the relay scheduler", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.effect("completes 1,000 yields while timers never fire", () =>
    Effect.gen(function* () {
      // A scheduler that yields through a timer stalls at its first yield, so
      // the wait ends on a real timer taken before the fake ones.
      const deadline = globalThis.setTimeout
      vi.useFakeTimers()
      let yields = 0
      const fiber = Effect.runFork(
        Effect.forEach(
          Array.from({ length: YIELDS }),
          () =>
            Effect.andThen(
              Effect.yieldNow,
              Effect.sync(() => {
                yields++
              })
            ),
          { discard: true }
        ),
        { scheduler: relayScheduler }
      )
      yield* Effect.callback<void>((resume) => {
        deadline(() => resume(Effect.void), 1000)
        fiber.addObserver(() => resume(Effect.void))
      })
      vi.useRealTimers()
      assert.strictEqual(yields, YIELDS)
      yield* Fiber.interrupt(fiber)
    })
  )
})
