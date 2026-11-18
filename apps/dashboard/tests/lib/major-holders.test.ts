import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { majorHolders } from "@/lib/major-holders"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

type Row = Above1Holder["rows"][number]

const row = (name: string, total: number, hundredths: number): Row => ({
  name,
  classification: "corporate",
  type: "CP",
  origin: "local",
  domicile: "INDONESIA",
  controller: undefined,
  total,
  percentageHundredths: hundredths,
})

// A holder of `rows`, summed, none of it in scrip unless `scrip` says.
const holder = (key: string, rows: ReadonlyArray<Row>, scrip = 0) => ({
  key,
  scripless: rows.reduce((sum, { total }) => sum + total, 0) - scrip,
  scrip,
  total: rows.reduce((sum, { total }) => sum + total, 0),
  percentageHundredths: rows.reduce(
    (sum, { percentageHundredths }) => sum + percentageHundredths,
    0
  ),
  rows,
})

const month = (
  dataDate: string,
  holders: ReadonlyArray<Above1Holder>
): MajorHoldersMonth => ({ dataDate, holders })

// Sep: A 20%, B 5%, C 2%, D 1.5%. Oct: A up to 20.5%, B the same %
// with a few more shares, C gone, D down to 1.2%, E new at 3%.
const SEPTEMBER = month("2026-09-30", [
  holder("A", [row("ALPHA", 2000, 2000)]),
  holder("B", [row("BETA", 500, 500)]),
  holder("C", [row("GAMMA", 200, 200)]),
  holder("D", [row("DELTA", 150, 150)]),
])
const OCTOBER = month("2026-10-30", [
  holder("D", [row("DELTA", 120, 120)]),
  holder("A", [row("ALPHA", 2050, 2050)]),
  holder("B", [row("BETA", 500.4, 500)]),
  holder("E", [row("EPSILON", 300, 300)]),
])

describe("Major holders' figures", () => {
  it.effect("open the newest month, holders by % with their change", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders([SEPTEMBER, OCTOBER], undefined)
      expect(shown?.dataDate).toBe("2026-10-30")
      expect(shown?.comparison).toEqual({
        kind: "compared",
        dataDate: "2026-09-30",
      })
      expect(
        shown?.listed.map(({ name, change, ppChange }) => [
          name,
          change,
          ppChange,
        ])
      ).toEqual([
        ["ALPHA", "up", 50],
        ["BETA", "unchanged", 0],
        ["EPSILON", "new", undefined],
        ["DELTA", "down", -30],
      ])
      expect(shown?.listed[0]?.shareChange).toBe(50)
      // Off list, with its last %.
      expect(
        shown?.offList.map(({ name, percentageHundredths }) => [
          name,
          percentageHundredths,
        ])
      ).toEqual([["GAMMA", 200]])
      expect(shown?.totalHundredths).toBe(2050 + 500 + 300 + 120)
      expect(shown?.counts).toEqual({ new: 1, up: 1, down: 1, offList: 1 })
    })
  )

  it.effect("show a month the URL names, and no change in the first", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders([SEPTEMBER, OCTOBER], "2026-09")
      expect(shown?.dataDate).toBe("2026-09-30")
      expect(shown?.comparison).toEqual({ kind: "first" })
      expect(shown?.listed.map(({ change }) => change)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ])
      expect(shown?.offList).toEqual([])
      expect(shown?.counts).toBeUndefined()
    })
  )

  it.effect("fall back to the newest for a month without holders", () =>
    Effect.gen(function* () {
      const months = [SEPTEMBER, OCTOBER, month("2026-11-30", [])]
      expect((yield* majorHolders(months, "2026-11"))?.dataDate).toBe(
        "2026-10-30"
      )
      expect((yield* majorHolders(months, "2025-01"))?.dataDate).toBe(
        "2026-10-30"
      )
    })
  )

  it.effect("compare nothing after a month without the stock", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders(
        [
          SEPTEMBER,
          month("2026-10-30", []),
          month("2026-11-30", [holder("A", [row("ALPHA", 2000, 2000)])]),
        ],
        undefined
      )
      expect(shown?.comparison).toEqual({ kind: "gap", dataDate: "2026-10-30" })
      expect(shown?.listed[0]?.change).toBeUndefined()
    })
  )

  it.effect("count a holder back after a gap as New", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders(
        [
          SEPTEMBER,
          OCTOBER,
          month("2026-11-30", [holder("C", [row("GAMMA", 200, 200)])]),
        ],
        undefined
      )
      expect(shown?.listed[0]?.change).toBe("new")
    })
  )

  it.effect("are none for a stock in no month", () =>
    Effect.gen(function* () {
      expect(
        yield* majorHolders([month("2026-10-30", [])], undefined)
      ).toBeUndefined()
    })
  )

  it.effect("name a holder after its largest row, flagged as any row is", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders(
        [
          month("2026-10-30", [
            holder(
              "P",
              [
                {
                  ...row("PARAGA ARTAMIDA, PT", 300, 300),
                  classification: undefined,
                  type: undefined,
                  origin: undefined,
                  domicile: undefined,
                },
                {
                  ...row("PT PARAGA ARTAMIDA", 700, 700),
                  origin: "foreign",
                  domicile: "SINGAPORE",
                  controller: "affiliate",
                },
              ],
              250
            ),
          ]),
        ],
        undefined
      )
      expect(shown?.listed[0]).toMatchObject({
        name: "PT PARAGA ARTAMIDA",
        controller: "affiliate",
        label: "Corporate",
        origin: "foreign",
        domicile: "SINGAPORE",
        percentageHundredths: 1000,
        total: 1000,
        inScrip: 0.25,
      })
    })
  )

  it.effect("label a Feb–Mar holder with its KSEI type", () =>
    Effect.gen(function* () {
      const shown = yield* majorHolders(
        [
          month("2026-02-27", [
            holder("X", [
              { ...row("X", 100, 100), classification: undefined, type: "ID" },
            ]),
          ]),
        ],
        undefined
      )
      expect(shown?.listed[0]?.label).toBe("Individual")
    })
  )
})
