// The dashboard Worker reads a request's path back under the dashboard base
// path; anything outside it is not the dashboard's.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import { pathUnderBase } from "@workspace/client/base-path"

describe("path under the base path", () => {
  it.effect("drops the base from a path under it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* pathUnderBase("/dashboard/market-live/live", "/dashboard"),
        Option.some("/market-live/live")
      )
      assert.deepStrictEqual(
        yield* pathUnderBase("/dashboard", "/dashboard"),
        Option.some("/")
      )
    })
  )

  it.effect("finds none outside the base", () =>
    Effect.gen(function* () {
      assert.isTrue(
        Option.isNone(yield* pathUnderBase("/market-live/live", "/dashboard"))
      )
      assert.isTrue(
        Option.isNone(yield* pathUnderBase("/dashboards-guide", "/dashboard"))
      )
    })
  )

  it.effect("keeps every path at the root base", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* pathUnderBase("/market-live/live", ""),
        Option.some("/market-live/live")
      )
    })
  )
})
