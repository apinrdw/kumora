import { describe, expect, it } from "@effect/vitest"
import { BrokerCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { Chip } from "@/lib/broker-inventory"

import {
  chipsOf,
  chipsSearch,
  inventoryWindow,
  lensOf,
  lensSearch,
  parseStockSearch,
  pickerSearch,
  selectionOf,
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
        {
          range: undefined,
          from: "2026-06-01",
          to: "2026-09-30",
          selFrom: undefined,
          selTo: undefined,
        }
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
        measure: undefined,
        investor: undefined,
        brokers: undefined,
      })
    })
  )

  it.effect(
    "carries the measure, filter and group chips to the next stock, and drops single brokers",
    () =>
      Effect.gen(function* () {
        const carried = (raw: Record<string, unknown>) =>
          Effect.flatMap(parseStockSearch({ tab: "brokers", ...raw }), (s) =>
            pickerSearch(s)
          )
        expect(
          yield* carried({
            measure: "value",
            investor: "foreign",
            brokers: "YP,sell,PD",
            from: "2026-06-01",
            to: "2026-09-30",
          })
        ).toStrictEqual({
          tab: "brokers",
          range: undefined,
          from: "2026-06-01",
          to: "2026-09-30",
          measure: "value",
          investor: "foreign",
          brokers: "sell",
        })
        // Both groups are the default; single brokers alone leave no chips.
        expect((yield* carried({ brokers: "buy,YP,sell" })).brokers).toBe(
          undefined
        )
        expect((yield* carried({ brokers: "YP,PD" })).brokers).toBe("")
        expect((yield* carried({ brokers: "" })).brokers).toBe("")
      })
  )
})

describe("the Broker inventory lens and chips in the URL", () => {
  it.effect("keeps net value and a Foreign or Domestic filter", () =>
    Effect.gen(function* () {
      expect(
        yield* parseStockSearch({ measure: "value", investor: "foreign" })
      ).toMatchObject({ measure: "value", investor: "foreign" })
      expect((yield* parseStockSearch({ investor: "domestic" })).investor).toBe(
        "domestic"
      )
      expect(yield* lensOf(yield* parseStockSearch({}))).toStrictEqual({
        measure: "lots",
        investor: "all",
      })
      expect(
        yield* lensOf(
          yield* parseStockSearch({ measure: "value", investor: "domestic" })
        )
      ).toStrictEqual({ measure: "value", investor: "domestic" })
    })
  )

  it.effect(
    "leaves the defaults out, and drops a lens that doesn't parse",
    () =>
      Effect.gen(function* () {
        for (const measure of ["lots", "Value", 1, ""])
          expect((yield* parseStockSearch({ measure })).measure).toBeUndefined()
        for (const investor of ["all", "F", "foreigners", true])
          expect(
            (yield* parseStockSearch({ investor })).investor
          ).toBeUndefined()
      })
  )

  it.effect("round-trips a lens, net lots over all sides left out", () =>
    Effect.gen(function* () {
      for (const lens of [
        { measure: "lots", investor: "all" },
        { measure: "value", investor: "foreign" },
        { measure: "lots", investor: "domestic" },
      ] as const)
        expect(
          yield* lensOf(yield* parseStockSearch(yield* lensSearch(lens)))
        ).toStrictEqual(lens)
      expect(
        yield* lensSearch({ measure: "lots", investor: "all" })
      ).toStrictEqual({ measure: undefined, investor: undefined })
    })
  )

  it.effect("round-trips the chips in order", () =>
    Effect.gen(function* () {
      const YP = BrokerCode.make("YP")
      const PD = BrokerCode.make("PD")
      const lists: ReadonlyArray<ReadonlyArray<Chip>> = [
        ["sell", YP, "buy"],
        [YP, PD],
        ["buy"],
        [],
      ]
      for (const chips of lists) {
        const search = yield* chipsSearch(chips)
        expect(
          yield* chipsOf(yield* parseStockSearch({ ...search }))
        ).toStrictEqual(chips)
      }
      expect(yield* chipsSearch(["sell", YP])).toStrictEqual({
        brokers: "sell,YP",
      })
    })
  )

  it.effect(
    "plots both groups by default, and leaves them out of the URL",
    () =>
      Effect.gen(function* () {
        expect(yield* chipsOf(yield* parseStockSearch({}))).toStrictEqual([
          "buy",
          "sell",
        ])
        expect(yield* chipsSearch(["buy", "sell"])).toStrictEqual({
          brokers: undefined,
        })
        expect((yield* parseStockSearch({ brokers: "buy,sell" })).brokers).toBe(
          undefined
        )
      })
  )

  it.effect("keeps an empty list as no chips", () =>
    Effect.gen(function* () {
      const search = yield* parseStockSearch({ brokers: "" })
      expect(search.brokers).toBe("")
      expect(yield* chipsOf(search)).toStrictEqual([])
    })
  )

  it.effect(
    "drops unknown codes and repeats, and the whole list when nothing in it parses",
    () =>
      Effect.gen(function* () {
        expect(
          (yield* parseStockSearch({ brokers: "YP,yp,XYZ,buy,YP,,top,PD" }))
            .brokers
        ).toBe("YP,buy,PD")
        for (const brokers of ["XYZ,top", ",", 42, ["YP"]])
          expect((yield* parseStockSearch({ brokers })).brokers).toBeUndefined()
      })
  )
})

describe("the drag selection in the URL", () => {
  // The axis of a read: Mon 2 to Fri 6 Nov 2026, then Mon 9 Nov.
  const days = [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-09",
  ].map((day) => WibDate.make(day))
  const selection = (raw: Record<string, unknown>) =>
    Effect.flatMap(parseStockSearch(raw), (search) => selectionOf(search, days))

  it.effect("round-trips a selection as the axis days it covers", () =>
    Effect.gen(function* () {
      expect(
        yield* parseStockSearch({ selFrom: "2026-11-03", selTo: "2026-11-05" })
      ).toMatchObject({ selFrom: "2026-11-03", selTo: "2026-11-05" })
      expect(
        yield* selection({ selFrom: "2026-11-03", selTo: "2026-11-05" })
      ).toStrictEqual([1, 3])
      // A weekend end covers the trading days inside it.
      expect(
        yield* selection({ selFrom: "2026-11-06", selTo: "2026-11-08" })
      ).toStrictEqual([4, 4])
    })
  )

  it.effect("drops a selection outside the range, or with no day in it", () =>
    Effect.gen(function* () {
      for (const raw of [
        { selFrom: "2026-10-30", selTo: "2026-11-03" },
        { selFrom: "2026-11-06", selTo: "2026-11-10" },
        { selFrom: "2026-11-07", selTo: "2026-11-08" },
      ])
        expect(yield* selection(raw)).toBeUndefined()
    })
  )

  it.effect("drops a selection missing an end, out of order or mangled", () =>
    Effect.gen(function* () {
      for (const raw of [
        { selFrom: "2026-11-03" },
        { selTo: "2026-11-03" },
        { selFrom: "2026-11-05", selTo: "2026-11-03" },
        { selFrom: "2026-11-3", selTo: "2026-11-05" },
      ])
        expect(yield* parseStockSearch(raw)).toMatchObject({
          selFrom: undefined,
          selTo: undefined,
        })
    })
  )

  it.effect("clears the selection when the range changes", () =>
    Effect.gen(function* () {
      expect(yield* windowSearch({ range: "1Y" })).toMatchObject({
        selFrom: undefined,
        selTo: undefined,
      })
    })
  )

  it.effect("never carries the selection to the next stock", () =>
    Effect.gen(function* () {
      const carried = yield* pickerSearch(
        yield* parseStockSearch({
          tab: "brokers",
          selFrom: "2026-11-03",
          selTo: "2026-11-05",
        })
      )
      expect(carried).not.toHaveProperty("selFrom")
      expect(carried).not.toHaveProperty("selTo")
    })
  )
})
