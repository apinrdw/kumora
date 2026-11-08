import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Effect, Fiber } from "effect"

import { FrameScheduler } from "@workspace/client"

// A requestAnimationFrame the test fires by hand.
const stubFrames = () => {
  const callbacks = new Map<number, () => void>()
  let nextId = 1
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id))
  const fire = () => {
    const due = [...callbacks.values()]
    callbacks.clear()
    for (const callback of due) callback()
  }
  return { callbacks, fire }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("FrameScheduler.layer", () => {
  it.effect("completes nextFrame on the next animation frame", () =>
    Effect.gen(function* () {
      const frames = stubFrames()
      const fiber = yield* FrameScheduler.use((s) => s.nextFrame).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      assert.strictEqual(frames.callbacks.size, 1)
      assert.isUndefined(fiber.pollUnsafe())
      frames.fire()
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(FrameScheduler.layer))
  )

  it.effect("cancels the frame when interrupted", () =>
    Effect.gen(function* () {
      const frames = stubFrames()
      const fiber = yield* FrameScheduler.use((s) => s.nextFrame).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(frames.callbacks.size, 0)
    }).pipe(Effect.provide(FrameScheduler.layer))
  )
})
