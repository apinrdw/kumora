import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  inventoryWindow,
  parseStockSearch,
  pickerSearch,
  windowSearch,
} from "@/lib/stock-search"

describe("the stock page's Broker inventory search params", () => {
  it.effect("keeps the tab, a preset and a Custom range", () =>
    Effect.gen(function* () {
      expect(yield* parseStockSearch({ tab: "brokers" })).toMatchObject({
        tab: "brokers",
      })
      for (const range of ["2W", "1M", "6M", "YTD", "1Y"])
        expect((yield* parseStockSearch({ range })).range).toBe(range)
      expect(
        yield* parseStockSearch({ from: "2026-06-01", to: "2026-09-30" })
      ).toMatchObject({ from: "2026-06-01", to: "2026-09-30" })
    })
  )

  it.effect("leaves the defaults out: Holdings and 3M", () =>
    Effect.gen(function* () {
      expect(yield* parseStockSearch({})).toMatchObject({
        tab: undefined,
        range: undefined,
        from: undefined,
        to: undefined,
      })
      expect((yield* parseStockSearch({ range: "3M" })).range).toBeUndefined()
    })
  )

  it.effect("drops a tab, preset or date that doesn't parse", () =>
    Effect.gen(function* () {
      for (const tab of ["holdings", "Brokers", 1, ""])
        expect((yield* parseStockSearch({ tab })).tab).toBeUndefined()
      for (const range of ["2w", "3Y", "MAX", 6, ""])
        expect((yield* parseStockSearch({ range })).range).toBeUndefined()
      for (const from of ["2026-02-30", "2026-6-01", "yesterday", 20260601])
        expect(
          yield* parseStockSearch({ from, to: "2026-09-30" })
        ).toMatchObject({ from: undefined, to: undefined })
    })
  )

  it.effect(
    "drops a Custom range missing an end, or ending before it starts",
    () =>
      Effect.gen(function* () {
        for (const raw of [
          { from: "2026-06-01" },
          { to: "2026-09-30" },
          { from: "2026-09-30", to: "2026-06-01" },
        ])
          expect(yield* parseStockSearch(raw)).toMatchObject({
            from: undefined,
            to: undefined,
          })
      })
  )

  it.effect("lets a Custom range replace the preset", () =>
    Effect.gen(function* () {
      expect(
        yield* parseStockSearch({
          range: "1Y",
          from: "2026-06-01",
          to: "2026-09-30",
        })
      ).toMatchObject({
        range: undefined,
        from: "2026-06-01",
        to: "2026-09-30",
      })
    })
  )

  it.effect("clamps a Custom range to 2 years", () =>
    Effect.gen(function* () {
      expect(
        yield* parseStockSearch({ from: "2019-03-04", to: "2026-09-30" })
      ).toMatchObject({ from: "2024-10-01", to: "2026-09-30" })
    })
  )
})

describe("the Broker inventory range in the URL", () => {
  it.effect("round-trips a preset and a Custom range, 3M left out", () =>
    Effect.gen(function* () {
      for (const range of ["2W", "1M", "3M", "6M", "YTD", "1Y"] as const) {
        const search = yield* windowSearch({ range })
        expect(search.range).toBe(range === "3M" ? undefined : range)
        expect(
          yield* inventoryWindow(yield* parseStockSearch({ ...search }))
        ).toStrictEqual({ range })
      }
      const custom = yield* parseStockSearch({
        from: "2026-06-01",
        to: "2026-09-30",
      })
      expect(yield* windowSearch(yield* inventoryWindow(custom))).toStrictEqual(
        { range: undefined, from: "2026-06-01", to: "2026-09-30" }
      )
    })
  )

  it.effect("carries the tab and range to the next stock, not the months", () =>
    Effect.gen(function* () {
      expect(
        yield* pickerSearch(
          yield* parseStockSearch({
            tab: "brokers",
            range: "1Y",
            month: "2026-09",
            sizeMonth: "2026-09",
            panel: "foreign",
          })
        )
      ).toStrictEqual({
        tab: "brokers",
        range: "1Y",
        from: undefined,
        to: undefined,
      })
    })
  )
})
