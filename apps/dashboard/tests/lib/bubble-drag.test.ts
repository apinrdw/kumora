import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { releaseVelocity } from "@/lib/bubble-drag"

const speed = ({ vx, vy }: { vx: number; vy: number }) => Math.hypot(vx, vy)

describe("a released bubble", () => {
  it.effect("keeps a fifth of a slow drag's speed, in its direction", () =>
    Effect.gen(function* () {
      const flung = yield* releaseVelocity({ vx: 6, vy: 8 })
      expect(flung.vx).toBeCloseTo(1.2)
      expect(flung.vy).toBeCloseTo(1.6)
    })
  )

  it.effect("never leaves faster than 2.5 px a frame", () =>
    Effect.gen(function* () {
      const flung = yield* releaseVelocity({ vx: 300, vy: -400 })
      expect(speed(flung)).toBeCloseTo(2.5)
      expect(flung.vx).toBeCloseTo(1.5)
      expect(flung.vy).toBeCloseTo(-2)
    })
  )

  it.effect("stays put when the pointer stood still", () =>
    Effect.gen(function* () {
      expect(yield* releaseVelocity({ vx: 0, vy: 0 })).toEqual({
        vx: 0,
        vy: 0,
      })
    })
  )
})
