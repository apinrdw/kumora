import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { split } from "@/lib/split"

describe("a two-way split", () => {
  it.effect("is each side's share of the whole", () =>
    Effect.gen(function* () {
      expect(yield* split(30, 10)).toEqual({ left: 0.75, right: 0.25 })
    })
  )

  it.effect("is none of a whole of nothing", () =>
    Effect.gen(function* () {
      expect(yield* split(0, 0)).toBeUndefined()
    })
  )
})
