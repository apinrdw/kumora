import { Deferred, Effect } from "effect"

import { FrameScheduler } from "./frame-scheduler.ts"

// A frame scheduler whose frames advance only when the test calls `step`.
export const manualFrames = Effect.sync(() => {
  let waiting: Array<Deferred.Deferred<void>> = []
  const scheduler = FrameScheduler.of({
    nextFrame: Effect.suspend(() => {
      const frame = Deferred.makeUnsafe<void>()
      waiting.push(frame)
      return Deferred.await(frame)
    }),
  })
  // Runs one frame: resumes everything waiting on it, then lets it finish.
  const step = Effect.gen(function* () {
    const frame = waiting
    waiting = []
    for (const deferred of frame) yield* Deferred.succeed(deferred, undefined)
    yield* Effect.repeat(Effect.yieldNow, { times: 10 })
  })
  return { scheduler, step }
})
