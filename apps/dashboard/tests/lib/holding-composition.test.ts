import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  type HoldingChart,
  holdingChart,
  monthChange,
  type SeriesKey,
} from "@/lib/holding-composition"
import type { SeriesMonth } from "@/server/holdings/stock-page"

// BBCA's September and October rows in KSEI's report, with June as a gap.
const BBCA: ReadonlyArray<SeriesMonth> = [
  { month: "2026-08", holdings: undefined },
  {
    month: "2026-09",
    holdings: {
      periodEnd: "2026-09-30",
      local: {
        ID: 11_035_044_652,
        CP: 671_347_885,
        MF: 1_210_601_063,
        IB: 437_363_600,
        IS: 2_443_936_090,
        SC: 106_939_090,
        PF: 325_321_300,
        FD: 73_781_960,
        OT: 14_333_700,
      },
      foreign: {
        ID: 328_344_780,
        CP: 623_633_631,
        MF: 20_806_195_113,
        IB: 2_276_862_272,
        IS: 649_668_050,
        SC: 409_080_321,
        PF: 5_028_638_519,
        FD: 325_704_405,
        OT: 5_686_894_689,
      },
    },
  },
  {
    month: "2026-10",
    holdings: {
      periodEnd: "2026-10-30",
      local: {
        ID: 12_030_567_470,
        CP: 752_250_260,
        MF: 1_072_720_030,
        IB: 517_672_400,
        IS: 2_310_613_490,
        SC: 119_977_978,
        PF: 302_459_300,
        FD: 72_753_960,
        OT: 15_254_200,
      },
      foreign: {
        ID: 324_800_480,
        CP: 575_351_467,
        MF: 20_393_323_810,
        IB: 2_382_605_437,
        IS: 666_444_425,
        SC: 457_281_188,
        PF: 4_718_402_998,
        FD: 320_342_605,
        OT: 5_420_869_622,
      },
    },
  },
]

const ALL_BUT_ID: ReadonlyArray<SeriesKey> = [
  "CP",
  "MF",
  "IB",
  "IS",
  "SC",
  "PF",
  "FD",
  "OT",
]

const shareOf = (chart: HoldingChart, month: string, key: string) => {
  const index = chart.series.findIndex((series) => series.key === key)
  return chart.columns.find((column) => column.month === month)?.shares?.[index]
}

describe("the Holding composition chart", () => {
  it.effect("stacks local vs foreign under All, as shares of scripless", () =>
    Effect.gen(function* () {
      const chart = yield* holdingChart(BBCA, "all", new Set())
      expect(chart.series.map(({ label }) => label)).toEqual([
        "Local",
        "Foreign",
      ])
      // 17,194,269,088 local of 52,453,691,120 scripless.
      expect(shareOf(chart, "2026-10", "local")).toBeCloseTo(0.3278, 4)
      expect(chart.axisMax).toBe(1)
    })
  )

  it.effect("keeps a gap as a column without shares", () =>
    Effect.gen(function* () {
      const chart = yield* holdingChart(BBCA, "local", new Set())
      expect(chart.columns.map(({ month }) => month)).toEqual([
        "2026-08",
        "2026-09",
        "2026-10",
      ])
      expect(chart.columns[0]?.shares).toBeUndefined()
    })
  )

  it.effect(
    "keeps a shown series' % of the whole origin, zooming the axis",
    () =>
      Effect.gen(function* () {
        const chart = yield* holdingChart(BBCA, "foreign", new Set(ALL_BUT_ID))
        // 324,800,480 of 35,259,422,032 foreign: 0.92%, not 100%.
        expect(shareOf(chart, "2026-10", "ID")).toBeCloseTo(0.009_21, 5)
        expect(chart.axisMax).toBe(0.01)
      })
  )

  it.effect("zooms to the next axis step above the tallest shown column", () =>
    Effect.gen(function* () {
      // Foreign MF: 57.6% in September, 57.8% in October.
      const mf = yield* holdingChart(
        BBCA,
        "foreign",
        new Set([...ALL_BUT_ID, "ID" as const].filter((key) => key !== "MF"))
      )
      expect(mf.axisMax).toBe(1)
      // Local IS: 15.0% and 13.4%.
      const is = yield* holdingChart(
        BBCA,
        "local",
        new Set([...ALL_BUT_ID, "ID" as const].filter((key) => key !== "IS"))
      )
      expect(is.axisMax).toBe(0.2)
      // Local IB: 2.68% and 3.01%.
      const ib = yield* holdingChart(
        BBCA,
        "local",
        new Set([...ALL_BUT_ID, "ID" as const].filter((key) => key !== "IB"))
      )
      expect(ib.axisMax).toBe(0.05)
    })
  )
})

describe("a month's change against the month before it", () => {
  it.effect("gives each shown series' previous share", () =>
    Effect.gen(function* () {
      const chart = yield* holdingChart(BBCA, "local", new Set())
      const change = yield* monthChange(chart, "2026-10", ["IS", "IB"])
      // September's local IS: 2,443,936,090 of 16,318,669,340; IB:
      // 437,363,600.
      expect(change._tag).toBe("From")
      if (change._tag !== "From") return
      expect(change.month).toBe("2026-09")
      expect([...change.was.keys()]).toEqual(["IS", "IB"])
      expect(change.was.get("IS")).toBeCloseTo(0.1498, 4)
      expect(change.was.get("IB")).toBeCloseTo(0.0268, 4)
    })
  )

  it.effect("names the month before when it is a gap", () =>
    Effect.gen(function* () {
      // July holds September's shares, before August's gap.
      const chart = yield* holdingChart(
        [{ month: "2026-07", holdings: BBCA[1]?.holdings }, ...BBCA],
        "local",
        new Set()
      )
      expect(yield* monthChange(chart, "2026-09", ["IS"])).toEqual({
        _tag: "NoData",
        month: "2026-08",
      })
    })
  )

  it.effect("is the first month when no month before it has data", () =>
    Effect.gen(function* () {
      const chart = yield* holdingChart(BBCA, "local", new Set())
      // August, a gap, is the series' only month before September.
      expect(yield* monthChange(chart, "2026-09", ["IS"])).toEqual({
        _tag: "First",
      })
    })
  )

  it.effect("leaves out a share that prints the same as the month before", () =>
    Effect.gen(function* () {
      const held = BBCA[2]?.holdings
      if (held === undefined) return
      // November is October with 1 more local individual share: ID prints
      // 69.97% of local both months, and IS 13.44%.
      const chart = yield* holdingChart(
        [
          ...BBCA,
          {
            month: "2026-11",
            holdings: {
              ...held,
              local: { ...held.local, ID: held.local.ID + 1 },
            },
          },
        ],
        "local",
        new Set()
      )
      const change = yield* monthChange(chart, "2026-11", ["ID", "IS"])
      expect(change).toEqual({ _tag: "From", month: "2026-10", was: new Map() })
    })
  )
})
