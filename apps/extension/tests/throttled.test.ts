// Each site's throttle deadline in chrome.storage.session (settings.ts), as
// both pacers save theirs.
import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Effect } from "effect"

import { loadThrottled, saveThrottled } from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the throttle deadlines", () => {
  it.effect("keeps both sites' when they throttle at once", () =>
    Effect.gen(function* () {
      memorySession()
      yield* Effect.all(
        [saveThrottled("Stockbit", 1_000), saveThrottled("Ajaib", 2_000)],
        { concurrency: "unbounded" }
      )
      assert.deepStrictEqual(yield* loadThrottled, {
        Stockbit: 1_000,
        Ajaib: 2_000,
      })
    })
  )
})
