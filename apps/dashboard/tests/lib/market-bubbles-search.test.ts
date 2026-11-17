import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  DEFAULT_VIEW,
  parseMarketBubblesSearch,
  PHONE_VIEW,
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

  it.effect(
    "opens a phone on Top 50, and keeps the device's own default out of the URL",
    () =>
      Effect.gen(function* () {
        expect(PHONE_VIEW).toEqual({ ...DEFAULT_VIEW, top: 50 })
        expect((yield* viewOfSearch({}, PHONE_VIEW)).top).toBe(50)
        expect(yield* searchOfView({ top: 50 }, PHONE_VIEW)).toStrictEqual({
          top: undefined,
        })
        expect(yield* searchOfView({ top: 100 }, PHONE_VIEW)).toStrictEqual({
          top: 100,
        })
        expect(yield* searchOfView({ top: 100 })).toStrictEqual({
          top: undefined,
        })
        // The route can't know the device, so a link's Top 100 or Top 50
        // stays: a phone opens `?top=100` on Top 100, a laptop `?top=50` on
        // Top 50.
        const shared = yield* parseMarketBubblesSearch({ top: 100 })
        expect(shared.top).toBe(100)
        expect((yield* viewOfSearch(shared, PHONE_VIEW)).top).toBe(100)
      })
  )
})
