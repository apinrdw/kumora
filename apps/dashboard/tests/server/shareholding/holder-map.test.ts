// The Holder map's read, after a real archive run stored the trimmed
// above-5% fixtures (11, 12, 24 and 25 Jun, 19 and 20 Nov 2026) and above-1%
// fixtures (Feb, Apr, Aug, Sep and Oct 2026), and real investor-type,
// above-5% and above-1% parse runs parsed them, through the Holder map view
// model.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { holderMapView } from "@/lib/holder-map"
import { holderMapRead } from "@/server/holdings/holder-map"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"

import {
  archiveAndParse,
  runParse,
  type World,
  world,
} from "./above-5-world.ts"

const parsed = Effect.gen(function* () {
  const w = world({ withAbove1: true })
  yield* archiveAndParse(w, "cron-2026-11-25")
  yield* runParse(above1ParseRuns)(w, "cron-2026-11-25")
  return w
})

const mapOf = Effect.fnUntraced(function* (
  w: World,
  code: string | undefined,
  day?: string
) {
  return yield* holderMapView(
    yield* holderMapRead({
      focus:
        code === undefined
          ? undefined
          : { kind: "stock", code: StockCode.make(code) },
      day: day === undefined ? undefined : WibDate.make(day),
    }).pipe(Effect.provide(w.holdings.layer))
  )
})

// A band's holders as the side panel lists them.
const rowsOf = (
  band:
    | {
        readonly holders: ReadonlyArray<{
          readonly name: string
          readonly percentageHundredths: number
          readonly shares: number
          readonly origin: string | undefined
          readonly investorType: string | undefined
        }>
      }
    | undefined
) =>
  (band?.holders ?? []).map((holder) => [
    holder.name,
    holder.percentageHundredths,
    holder.shares,
    holder.origin,
    holder.investorType,
  ])

describe("Holder map, stock focus", () => {
  it.effect(
    "opens on the newest trading day and the newest above-1% month on or before it",
    () =>
      Effect.gen(function* () {
        const map = yield* mapOf(yield* parsed, "TRUE")
        assert.strictEqual(map.day, "2026-11-20")
        assert.strictEqual(map.month, "2026-10-30")
        assert.isDefined(map.focus)
        assert.strictEqual(map.focus?.code, "TRUE")
        assert.strictEqual(map.focus?.issuerName, "TRINITI DINAMIK Tbk, PT")
        const [above5, above1] = map.focus?.bands ?? []
        // Its above-5% holders that day, their KSEI type from their ≥1%
        // rows of the month.
        assert.deepStrictEqual(rowsOf(above5), [
          ["PT AGUNG PERKASA INVESTINDO", 5283, 4_000_000_000, "local", "CP"],
          ["PT PERINTIS TRINITI PROPERTI TBK", 695, 525_939_584, "local", "CP"],
        ])
        assert.strictEqual(above5?.totalHundredths, 5978)
        // Oct's ≥1% holders, but for the two above 5% on 20 Nov, each shown
        // once, in the 5% band.
        assert.deepStrictEqual(rowsOf(above1), [
          ["VALTOS GLOBALINDO PT", 272, 205_588_000, "local", undefined],
          ["VINCENT YO", 142, 107_569_484, "local", "ID"],
        ])
        assert.strictEqual(above1?.totalHundredths, 414)
      })
  )

  it.effect(
    "as of a picked day, takes the newest above-1% month on or before it",
    () =>
      Effect.gen(function* () {
        const map = yield* mapOf(yield* parsed, "TRUE", "2026-06-25")
        assert.strictEqual(map.day, "2026-06-25")
        assert.strictEqual(map.month, "2026-04-30")
        const [above5, above1] = map.focus?.bands ?? []
        assert.deepStrictEqual(
          rowsOf(above5).map(([name]) => name),
          ["PT AGUNG PERKASA INVESTINDO"]
        )
        // Perintis is at 14.49% in April's report and not on 25 Jun's
        // above-5% list: it stays in the 1% band.
        assert.deepStrictEqual(
          rowsOf(above1).map(([name, hundredths]) => [name, hundredths]),
          [
            ["PT PERINTIS TRINITI PROPERTI TBK", 1449],
            ["PT PANCA AGUNG GEMILANG", 531],
            ["DJONI", 509],
            ["VALTOS GLOBALINDO PT", 272],
            ["VINCENT YO", 142],
          ]
        )
      })
  )

  it.effect("shows an investor's repeat blocks once", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "ASRI", "2026-11-19")
      const [above5] = map.focus?.bands ?? []
      assert.deepStrictEqual(
        rowsOf(above5).map(([name, hundredths]) => [name, hundredths]),
        [
          ["MANUNGGAL PRIME DEVELOPMENT, PT", 2103],
          ["PT. TANGERANG FAJAR INDUSTRIAL ESTATE", 1054],
          ["PT MAYBANK SEKURITAS INDONESIA - REGISTRAR", 866],
        ]
      )
    })
  )

  it.effect("shows a stock's two blocks of one name as one holder", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "CPGT")
      const [above5] = map.focus?.bands ?? []
      assert.deepStrictEqual(
        rowsOf(above5).map(([name, hundredths, shares]) => [
          name,
          hundredths,
          shares,
        ]),
        [
          ["ASIA ARGENTUM ASSETS HONG KONG LIMITED", 2912, 1_156_687_126],
          ["RECKSON LIMITED", 2912, 1_156_687_126],
          ["PARALLAX VENTURE PARTNERS VIII LTD", 909, 361_111_100],
          ["ASIA ARGENTUM ASSETS PTE LTD", 524, 208_220_500],
        ]
      )
    })
  )

  it.effect("finds no holder of a code no report lists", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "ZZZZ")
      assert.strictEqual(map.focus?.code, "ZZZZ")
      assert.isUndefined(map.focus?.issuerName)
      assert.isTrue(
        map.focus?.bands.every(({ holders }) => holders.length === 0)
      )
    })
  )
})

describe("Holder map, no focus", () => {
  it.effect("lists the stocks with the most ≥1% holders", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, undefined)
      assert.isUndefined(map.focus)
      assert.strictEqual(map.month, "2026-10-30")
      assert.deepStrictEqual(
        map.mostHeld.map(({ code, holders }) => [code, holders]),
        [
          ["FLMC", 13],
          ["AADI", 10],
          ["BSDE", 7],
          ["RALS", 7],
          ["TLKM", 5],
          ["TRUE", 4],
        ]
      )
    })
  )
})
