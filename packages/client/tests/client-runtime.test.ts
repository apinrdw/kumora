import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { FrameScheduler, clientRuntime } from "@workspace/client"

describe("client runtime", () => {
  // Node has no requestAnimationFrame, so building here proves the client
  // layer touches no browser API until a frame is awaited.
  it.effect("builds outside a browser and provides the frame scheduler", () =>
    Effect.gen(function* () {
      const scheduler = yield* Effect.promise(() =>
        clientRuntime.runPromise(FrameScheduler.use(Effect.succeed))
      )
      assert.isDefined(scheduler.nextFrame)
    })
  )
})
