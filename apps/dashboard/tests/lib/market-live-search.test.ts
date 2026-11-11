import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseMarketLiveSearch } from "@/lib/market-live-search"

describe("the Market Live search params", () => {
  it.effect("keeps a listed code's shape, warrants included", () =>
    Effect.gen(function* () {
      expect(yield* parseMarketLiveSearch({ code: "BBRI" })).toMatchObject({
        code: "BBRI",
      })
      expect(yield* parseMarketLiveSearch({ code: "AMAG-W2" })).toMatchObject({
        code: "AMAG-W2",
      })
    })
  )

  it.effect("keeps an index", () =>
    Effect.gen(function* () {
      for (const code of ["IHSG", "TN.IHSG", "NG.IHSG"])
        expect((yield* parseMarketLiveSearch({ code })).code).toBe(code)
    })
  )

  it.effect("drops a code that isn't one, so the page falls back", () =>
    Effect.gen(function* () {
      for (const code of [
        "not a code",
        "bbri",
        "",
        42,
        "TOOLONGFORACODE12",
        ".IHSG",
      ])
        expect((yield* parseMarketLiveSearch({ code })).code).toBeUndefined()
      expect(yield* parseMarketLiveSearch({})).toStrictEqual({
        code: undefined,
        day: undefined,
      })
    })
  )

  it.effect("keeps a recorded day's date and drops anything else", () =>
    Effect.gen(function* () {
      expect(yield* parseMarketLiveSearch({ day: "2026-11-06" })).toMatchObject(
        {
          day: "2026-11-06",
        }
      )
      for (const day of [
        "2026-11-6",
        "06-11-2026",
        "yesterday",
        20261106,
        "",
        "2026-13-01",
        "2026-02-30",
      ])
        expect((yield* parseMarketLiveSearch({ day })).day).toBeUndefined()
    })
  )
})
