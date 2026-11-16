import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  DEFAULT_VIEW,
  parseMarketBubblesSearch,
  searchOfView,
  viewOfSearch,
} from "@/lib/market-bubbles-search"

describe("the Market Bubbles search params", () => {
  it.effect("keeps each field that parses", () =>
    Effect.gen(function* () {
      const search = yield* parseMarketBubblesSearch({
        size: "freq",
        colour: "change",
        window: "30s",
        top: "all",
      })
      expect(yield* viewOfSearch(search)).toEqual({
        size: "freq",
        colour: "change",
        window: "30s",
        top: "all",
      })
      // The router reads `?top=50` as a number.
      expect((yield* parseMarketBubblesSearch({ top: 50 })).top).toBe(50)
    })
  )

  it.effect("drops what doesn't parse, so a stale link still opens", () =>
    Effect.gen(function* () {
      const search = yield* parseMarketBubblesSearch({
        size: "lots",
        colour: 1,
        window: "2m",
        top: 20,
      })
      expect(yield* viewOfSearch(search)).toEqual(DEFAULT_VIEW)
      expect(DEFAULT_VIEW).toEqual({
        size: "value",
        colour: "delta",
        window: "5m",
        top: 100,
      })
    })
  )

  it.effect("keeps a default out of the URL", () =>
    Effect.gen(function* () {
      expect(
        yield* parseMarketBubblesSearch({
          size: "value",
          colour: "delta",
          window: "5m",
          top: 100,
        })
      ).toStrictEqual({
        size: undefined,
        colour: undefined,
        window: undefined,
        top: undefined,
        sector: undefined,
      })
      expect(yield* searchOfView({ window: "5m" })).toStrictEqual({
        window: undefined,
      })
      expect(yield* searchOfView({ window: "1h", top: 50 })).toStrictEqual({
        window: "1h",
        top: 50,
      })
    })
  )

  it.effect("keeps one sector, Unclassified too, and drops any other", () =>
    Effect.gen(function* () {
      expect(
        (yield* parseMarketBubblesSearch({
          sector: "Properties & Real Estate",
        })).sector
      ).toBe("Properties & Real Estate")
      expect(
        (yield* parseMarketBubblesSearch({ sector: "Unclassified" })).sector
      ).toBe("Unclassified")
      expect(
        (yield* parseMarketBubblesSearch({ sector: "Banks" })).sector
      ).toBeUndefined()
      expect((yield* viewOfSearch({ sector: "Energy" })).sector).toBe("Energy")
      // All sectors is the default: no sector in the URL.
      expect(DEFAULT_VIEW.sector).toBeUndefined()
    })
  )
})
