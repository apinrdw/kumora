// The Holder map's read, after a real archive run stored the trimmed
// above-5% fixtures (11, 12, 24 and 25 Jun, 19 and 20 Nov 2026) and above-1%
// fixtures (Feb, Apr, Aug, Sep and Oct 2026), and real investor-type,
// above-5% and above-1% parse runs parsed them, through the Holder map view
// model.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { holderMapView } from "@/lib/holder-map"
import {
  type HolderMapLink,
  holderMapRead,
  holderMapStocks,
} from "@/server/holdings/holder-map"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"

import {
  archive,
  archiveAndParse,
  parse,
  republish,
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

// A band's holders with their stored moves.
const movesOf = (
  band:
    | {
        readonly holders: ReadonlyArray<{
          readonly name: string
          readonly move: HolderMapLink["move"]
        }>
      }
    | undefined
) => (band?.holders ?? []).map(({ name, move }) => [name, move?.kind])

describe("Holder map, holder moves", () => {
  it.effect(
    "gives a 5%-band holder its stored move against the trading day before",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const [nov20] = (yield* mapOf(w, "TRUE")).focus?.bands ?? []
        // Agung holds as it did on 19 Nov: no move.
        assert.deepStrictEqual(movesOf(nov20), [
          ["PT AGUNG PERKASA INVESTINDO", undefined],
          ["PT PERINTIS TRINITI PROPERTI TBK", "down"],
        ])
        const perintis = nov20?.holders[1]?.move
        assert.strictEqual(perintis?.shareChange, -58_765_800)
        assert.strictEqual(perintis?.percentageChange, -77)
        const [nov19] =
          (yield* mapOf(w, "TRUE", "2026-11-19")).focus?.bands ?? []
        assert.deepStrictEqual(movesOf(nov19), [
          ["PT AGUNG PERKASA INVESTINDO", undefined],
          ["PT PERINTIS TRINITI PROPERTI TBK", "new"],
        ])
      })
  )

  it.effect(
    "gives a 1%-band holder its stored move against the month before",
    () =>
      Effect.gen(function* () {
        const [, april] =
          (yield* mapOf(yield* parsed, "TRUE", "2026-06-25")).focus?.bands ?? []
        assert.deepStrictEqual(movesOf(april), [
          ["PT PERINTIS TRINITI PROPERTI TBK", undefined],
          ["PT PANCA AGUNG GEMILANG", "down"],
          ["DJONI", undefined],
          ["VALTOS GLOBALINDO PT", undefined],
          ["VINCENT YO", undefined],
        ])
        assert.strictEqual(april?.holders[1]?.move?.shareChange, -28_512_300)
        assert.strictEqual(april?.holders[1]?.move?.percentageChange, -37)
      })
  )
})

describe("Holder map, gap holders", () => {
  it.effect(
    "marks a 1%-band holder at 5% or more that the day's above-5% list misses",
    () =>
      Effect.gen(function* () {
        const [, april] =
          (yield* mapOf(yield* parsed, "TRUE", "2026-06-25")).focus?.bands ?? []
        assert.deepStrictEqual(
          (april?.holders ?? []).map(({ name, gap }) => [name, gap]),
          [
            ["PT PERINTIS TRINITI PROPERTI TBK", true],
            ["PT PANCA AGUNG GEMILANG", true],
            ["DJONI", true],
            ["VALTOS GLOBALINDO PT", false],
            ["VINCENT YO", false],
          ]
        )
      })
  )

  it.effect("marks no holder the day lists", () =>
    Effect.gen(function* () {
      const bands = (yield* mapOf(yield* parsed, "TRUE")).focus?.bands ?? []
      assert.isTrue(
        bands.every(({ holders }) => holders.every(({ gap }) => !gap))
      )
    })
  )
})

describe("Holder map, band crossing", () => {
  it.effect("moves a 5%-band holder under 5% in the month Up into 5%", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      // Oct's report printing Perintis at 4.50%, not 9.93%: it crossed
      // 5% between the month and 20 Nov.
      w.holdings.database
        .prepare(
          `UPDATE above_1_holding SET percentage_hundredths = 450
            WHERE data_date = '2026-10-30' AND stock_code = 'TRUE'
              AND holder_key = 'PERINTIS PROPERTI TRINITI'`
        )
        .run()
      const map = yield* mapOf(w, "TRUE")
      const [above5] = map.focus?.bands ?? []
      assert.deepStrictEqual(
        (above5?.holders ?? []).map(({ name, crossing }) => [name, crossing]),
        [
          ["PT AGUNG PERKASA INVESTINDO", undefined],
          [
            "PT PERINTIS TRINITI PROPERTI TBK",
            { kind: "up into 5%", monthHundredths: 450 },
          ],
        ]
      )
    })
  )

  it.effect(
    "moves a 1%-band holder that left the above-5% list after the month Down out of 5%, never Off list",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // 20 Nov republished as BIKE's alone: TRUE's two above-5% holders
        // leave the list that day, after Oct's report.
        republish(w, "2026-11-20", "republished")
        yield* archive(w, "cron-2026-11-26T13")
        yield* parse(w, "cron-2026-11-26")
        const map = yield* mapOf(w, "TRUE")
        const [above5, above1] = map.focus?.bands ?? []
        assert.deepStrictEqual(above5?.holders, [])
        const down = {
          kind: "down out of 5%" as const,
          since: WibDate.make("2026-11-20"),
        }
        assert.deepStrictEqual(
          (above1?.holders ?? []).map(({ name, crossing, gap }) => [
            name,
            crossing,
            gap,
          ]),
          [
            ["PT AGUNG PERKASA INVESTINDO", down, true],
            ["PT PERINTIS TRINITI PROPERTI TBK", down, true],
            ["VALTOS GLOBALINDO PT", undefined, false],
            ["VINCENT YO", undefined, false],
          ]
        )
        assert.deepStrictEqual(
          map.focus?.offList.map(({ name }) => name),
          ["PT PANCA AGUNG GEMILANG", "DJONI"]
        )
      })
  )

  it.effect("crosses nothing for a holder that left before the month", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "TRUE")
      assert.isTrue(
        (map.focus?.bands ?? []).every(({ holders }) =>
          holders.every(({ crossing }) => crossing === undefined)
        )
      )
    })
  )
})

describe("Holder map, Off list", () => {
  it.effect(
    "lists the focus's earlier holders with the period each left the list",
    () =>
      Effect.gen(function* () {
        const map = yield* mapOf(yield* parsed, "TRUE")
        // Djoni left Aug's ≥1% list and Panca Sep's, each still off it in
        // Oct.
        assert.deepStrictEqual(
          map.focus?.offList.map(({ name, band, since }) => [
            name,
            band,
            since,
          ]),
          [
            ["PT PANCA AGUNG GEMILANG", "1%", "2026-09-30"],
            ["DJONI", "1%", "2026-08-31"],
          ]
        )
      })
  )

  it.effect("lists no holder that left after the as-of day", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "TRUE", "2026-06-25")
      assert.deepStrictEqual(map.focus?.offList, [])
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

  it.effect(
    "searches every stock of the newest day's and month's reports",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const stocks = yield* holderMapStocks.pipe(
          Effect.provide(w.holdings.layer)
        )
        assert.deepStrictEqual(
          stocks.map(({ code }) => code),
          [
            "AADI",
            "ASRI",
            "BIKE",
            "BSDE",
            "CPGT",
            "ENRG",
            "FLMC",
            "MAMIP",
            "NSSS",
            "RALS",
            "TLKM",
            "TRUE",
          ]
        )
        assert.strictEqual(
          stocks.find(({ code }) => code === "TRUE")?.issuerName,
          "TRINITI DINAMIK Tbk, PT"
        )
      })
  )
})
