import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { isActivationKey } from "@/components/k/keyboard"

describe("isActivationKey", () => {
  it.effect("Enter and Space activate, like a native button", () =>
    Effect.gen(function* () {
      expect(yield* isActivationKey("Enter")).toBe(true)
      expect(yield* isActivationKey(" ")).toBe(true)
    })
  )

  it.effect("other keys do not activate", () =>
    Effect.gen(function* () {
      expect(yield* isActivationKey("Tab")).toBe(false)
      expect(yield* isActivationKey("ArrowDown")).toBe(false)
      expect(yield* isActivationKey("Spacebar")).toBe(false)
    })
  )
})
