import { describe, expect, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import {
  holderMapMoveSearch,
  parseHolderMapSearch,
  queryOf,
} from "@/lib/holder-map-search"

describe("parseHolderMapSearch", () => {
  it.effect("keeps a stock focus, in any case, and an as-of day", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        stock: "true",
        day: "2026-06-25",
      })
      expect(search).toEqual({ stock: "TRUE", day: "2026-06-25" })
      expect(yield* queryOf(search)).toEqual({
        focus: { kind: "stock", code: "TRUE" },
        day: "2026-06-25",
      })
    })
  )

  it.effect("drops what doesn't parse, leaving the landing view", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        stock: "no such code!",
        day: "2026-02-30",
        other: "x",
      })
      expect(search).toEqual({ stock: undefined, day: undefined })
      expect(yield* queryOf(search)).toEqual({
        focus: undefined,
        day: undefined,
      })
    })
  )
})

describe("holderMapMoveSearch", () => {
  const TRUE = StockCode.make("TRUE")

  it.effect("focuses a Daily row's stock as of the row's day", () =>
    Effect.gen(function* () {
      expect(
        yield* holderMapMoveSearch("daily", TRUE, WibDate.make("2026-11-20"))
      ).toEqual({
        stock: "TRUE",
        day: "2026-11-20",
      })
    })
  )

  it.effect("opens a Monthly row's stock on the newest day", () =>
    Effect.gen(function* () {
      expect(
        yield* holderMapMoveSearch("monthly", TRUE, WibDate.make("2026-10-30"))
      ).toEqual({ stock: "TRUE" })
    })
  )
})
