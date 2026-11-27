// The Holder map's read, after a real archive run stored the trimmed
// above-5% fixtures (11, 12, 24 and 25 Jun, 19 and 20 Nov 2026) and above-1%
// fixtures (Feb, Apr, Aug, Sep and Oct 2026), and real investor-type,
// above-5% and above-1% parse runs parsed them, through the Holder map view
// model.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { CustodianId, HolderKey } from "@/domain/holdings"
import { holderMapView } from "@/lib/holder-map"
import { holderKey } from "@/server/holdings/holder-key"
import { holderMapRead } from "@/server/holdings/holder-map"
import { custodianOf } from "@/server/holdings/holder-map-custodians"
import type {
  HolderMapLink,
  HolderMapRead,
} from "@/server/holdings/holder-map-schema"
import { holderMapSearchList } from "@/server/holdings/holder-map-search-list"
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
import {
  above1Item,
  above5Items,
  fakeIdx,
  listedSharesItems,
} from "./fake-idx.ts"
import { memoryBucket } from "../archive/memory-bucket.ts"
import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

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
        assert.deepInclude(map.focus, {
          kind: "stock",
          code: StockCode.make("TRUE"),
          issuerName: "TRINITI DINAMIK Tbk, PT",
        })
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
      assert.deepInclude(map.focus, {
        kind: "stock",
        code: StockCode.make("ZZZZ"),
        issuerName: undefined,
      })
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

  // CPGT lists two blocks named ASIA ARGENTUM ASSETS HONG KONG LIMITED,
  // 8.17% at Deutsche Bank and 20.95% at Trimegah: one holder on the map.
  const ARGENTUM = "ASIA ARGENTUM ASSETS HONG KONG LIMITED"
  const argentumOf = Effect.fnUntraced(function* (w: World) {
    const [above5] = (yield* mapOf(w, "CPGT")).focus?.bands ?? []
    const stockFocus = above5?.holders.find(({ name }) => name === ARGENTUM)
    const holderFocus = (yield* holderReadOf(w, ARGENTUM)).links.find(
      ({ code, band }) => code === "CPGT" && band === "5%"
    )
    return {
      percentageHundredths: stockFocus?.percentageHundredths,
      move: stockFocus?.move,
      holderFocusMove: holderFocus?.move,
    }
  })

  it.effect(
    "moves a holder whose one block left beside an unchanged one Down by its summed change",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        republish(w, "2026-11-20", "argentum-gone-2026-11-20")
        yield* archive(w, "cron-2026-11-26T13")
        yield* parse(w, "cron-2026-11-26")
        const down = {
          kind: "down" as const,
          shareChange: -832_312_874,
          percentageChange: -2095,
        }
        assert.deepStrictEqual(yield* argentumOf(w), {
          percentageHundredths: 817,
          move: down,
          holderFocusMove: down,
        })
      })
  )

  it.effect(
    "moves a holder whose one block arrived beside an unchanged one Up, never New",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        republish(w, "2026-11-19", "argentum-gone-2026-11-19")
        yield* archive(w, "cron-2026-11-26T13")
        yield* parse(w, "cron-2026-11-26")
        const up = {
          kind: "up" as const,
          shareChange: 832_312_874,
          percentageChange: 2095,
        }
        assert.deepStrictEqual(yield* argentumOf(w), {
          percentageHundredths: 2912,
          move: up,
          holderFocusMove: up,
        })
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

// The read of a holder focus, by the key of `name`.
const holderReadOf = Effect.fnUntraced(function* (
  w: World,
  name: string,
  day?: string
) {
  return yield* holderMapRead({
    focus: { kind: "holder", key: HolderKey.make(yield* holderKey(name)) },
    day: day === undefined ? undefined : WibDate.make(day),
  }).pipe(Effect.provide(w.holdings.layer))
})

const stockReadOf = (w: World, code: string) =>
  holderMapRead({
    focus: { kind: "stock", code: StockCode.make(code) },
    day: undefined,
  }).pipe(Effect.provide(w.holdings.layer))

// Links as a reader sees them: stock, band, name, %.
const linksOf = (links: ReadonlyArray<HolderMapLink>) =>
  links.map(({ code, band, name, percentageHundredths }) => [
    code,
    band,
    name,
    percentageHundredths,
  ])

const BPJS = "DJS KETENAGAKERJAAN PROGRAM JAMINAN HARI TUA"

describe("Holder map, second hop", () => {
  it.effect("links each holder of a focus stock to its other stocks", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      // BPJS holds BSDE and TLKM in Oct's report.
      assert.deepStrictEqual(linksOf((yield* stockReadOf(w, "BSDE")).hops), [
        ["TLKM", "1%", BPJS, 240],
      ])
      // Maybank is above 5% of ASRI and ENRG on 20 Nov, and up in ENRG
      // since the day before.
      const asri = yield* stockReadOf(w, "ASRI")
      assert.deepStrictEqual(
        asri.hops.map(({ code, band, name, move }) => [
          code,
          band,
          name,
          move?.kind,
        ]),
        [["ENRG", "5%", "MAYBANK SEKURITAS INDONESIA", "up"]]
      )
      assert.deepStrictEqual(
        asri.issuers.map(({ code }) => code),
        ["ASRI", "ENRG"]
      )
    })
  )

  it.effect("draws no second hop for holders of no other stock", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* stockReadOf(yield* parsed, "TRUE")).hops,
        []
      )
    })
  )
})

describe("Holder map, holder focus", () => {
  it.effect("links a holder to its stocks and their other holders", () =>
    Effect.gen(function* () {
      const read = yield* holderReadOf(yield* parsed, BPJS)
      assert.deepStrictEqual(read.focus, {
        kind: "holder",
        key: HolderKey.make("DJS HARI JAMINAN KETENAGAKERJAAN PROGRAM TUA"),
        name: BPJS,
      })
      assert.deepStrictEqual(linksOf(read.links), [
        ["BSDE", "1%", BPJS, 270],
        ["TLKM", "1%", BPJS, 240],
      ])
      // BSDE's six other ≥1% holders and TLKM's four, each with its move.
      assert.deepStrictEqual(
        read.hops.map(({ code, name, move }) => [code, name, move?.kind]),
        [
          ["BSDE", "METROPOLITAN TRANSCITIES INDONESIA, PT", undefined],
          ["BSDE", "PT EKACENTRA USAHAMAJU", undefined],
          ["BSDE", "PT PARAGA ARTAMIDA", undefined],
          ["BSDE", "PT. BUMI SERPONG DAMAI Tbk", undefined],
          ["BSDE", "PT. SIMAS TUNGGAL CENTER", undefined],
          ["BSDE", "TASPEN", undefined],
          ["TLKM", "DANANTARA ASSET MANAGEMENT", "new"],
          ["TLKM", "THE BANK OF NEW YORK MELLON", "up"],
          ["TLKM", "THE PRUDENTIAL ASSURANCE COMPANY LIMITED", "up"],
          ["TLKM", "EMPLOYEES PROVIDENT FUND BOARD", "down"],
        ]
      )
      assert.deepStrictEqual(
        read.issuers.map(({ code, issuerName }) => [code, issuerName]),
        [
          ["BSDE", "BUMI SERPONG DAMAI Tbk"],
          ["TLKM", "TELKOM INDONESIA (PERSERO) Tbk"],
        ]
      )
      assert.deepStrictEqual(read.offList, [])
    })
  )

  it.effect(
    "shows a holder in both reports of one stock once, in the 5% band, beside its 1% holding of another",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // Agung, above 5% of TRUE on 20 Nov and in TRUE's Oct report too,
        // also holds 2.00% of TLKM in Oct.
        w.holdings.database
          .prepare(
            `INSERT INTO above_1_holding VALUES ('2026-10-30', 'TLKM', 999,
              'TELKOM INDONESIA (PERSERO) Tbk', 'AGUNG PERKASA INVESTINDO, PT',
              ?, NULL, 'CP', 'local', NULL, NULL, NULL, 2000000, 0, 2000000,
              200)`
          )
          .run(yield* holderKey("PT AGUNG PERKASA INVESTINDO"))
        const agung = yield* holderReadOf(w, "PT AGUNG PERKASA INVESTINDO")
        assert.sameDeepMembers(linksOf(agung.links), [
          ["TRUE", "5%", "PT AGUNG PERKASA INVESTINDO", 5283],
          ["TLKM", "1%", "AGUNG PERKASA INVESTINDO, PT", 200],
        ])
        // TRUE's focus reaches TLKM through Agung.
        assert.deepStrictEqual(linksOf((yield* stockReadOf(w, "TRUE")).hops), [
          ["TLKM", "1%", "AGUNG PERKASA INVESTINDO, PT", 200],
        ])
      })
  )

  it.effect("lists the stocks a holder left as its Off list", () =>
    Effect.gen(function* () {
      // Djoni left TRUE's ≥1% list in Aug and holds nothing since.
      const read = yield* holderReadOf(yield* parsed, "DJONI")
      assert.deepStrictEqual(read.focus, {
        kind: "holder",
        key: HolderKey.make("DJONI"),
        name: "DJONI",
      })
      assert.deepStrictEqual(read.links, [])
      assert.deepStrictEqual(
        read.offList.map(({ code, band, since }) => [code, band, since]),
        [["TRUE", "1%", "2026-08-31"]]
      )
      assert.deepStrictEqual(
        read.issuers.map(({ code }) => code),
        ["TRUE"]
      )
    })
  )

  it.effect("finds nothing for a key no report lists", () =>
    Effect.gen(function* () {
      const read = yield* holderReadOf(yield* parsed, "NOBODY AT ALL")
      assert.strictEqual(read.focus?.kind, "holder")
      assert.isUndefined(
        read.focus?.kind === "holder" ? read.focus.name : "a stock"
      )
      assert.deepStrictEqual(
        [read.links, read.hops, read.offList],
        [[], [], []]
      )
    })
  )
})

// The read of a custodian focus, by its id.
const custodianReadOf = (w: World, id: string, day?: string) =>
  holderMapRead({
    focus: { kind: "custodian", id: CustodianId.make(id) },
    day: day === undefined ? undefined : WibDate.make(day),
  }).pipe(Effect.provide(w.holdings.layer))

// Custodian links as a reader sees them: stock, holder key, custodian id
// and name, shares through it.
const custodiansOf = (read: HolderMapRead) =>
  read.custodians.map(({ code, holder, custodian, name, shares }) => [
    code,
    holder,
    custodian,
    name,
    shares,
  ])

// One more securities account of a block of a day, 20 Nov 2026 unless
// told.
const addAccount = (
  w: World,
  code: string,
  no: number,
  custodian: string,
  shares: number,
  day = "2026-11-20"
) =>
  w.holdings.database
    .prepare(
      `INSERT INTO above_5_account VALUES (?, ?, ?, 99, ?,
        'ACCOUNT', 'local', NULL, NULL, ?)`
    )
    .run(day, code, no, custodian, shares)

const AGUNG = "AGUNG INVESTINDO PERKASA"
const PERINTIS = "PERINTIS PROPERTI TRINITI"
const MAYBANK = "INDONESIA MAYBANK SEKURITAS"
const MANUNGGAL = "DEVELOPMENT MANUNGGAL PRIME"

describe("Holder map, custodians", () => {
  it.effect(
    "links a stock focus's above-5% holders to their custodians by broker code",
    () =>
      Effect.gen(function* () {
        // Both of TRUE's blocks sit at PT MIRAE ASSET SEKURITAS INDONESIA,
        // broker YP, named as IDX lists the member.
        assert.deepStrictEqual(
          custodiansOf(yield* stockReadOf(yield* parsed, "TRUE")),
          [
            ["TRUE", AGUNG, "YP", "MIRAE ASSET SEKURITAS INDONESIA", 4e9],
            [
              "TRUE",
              PERINTIS,
              "YP",
              "MIRAE ASSET SEKURITAS INDONESIA",
              525_939_584,
            ],
          ]
        )
      })
  )

  it.effect(
    "keys a custodian without a code named at the parse's longest",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // The above-5% parse's longest custodian name (above-5.ts,
        // MAX_NAME_LENGTH), one word: its key is as long.
        const name = "X".repeat(256)
        addAccount(w, "CPGT", 7, name, 2_000)
        const id = `NAME:${name}`
        const stock = custodiansOf(yield* stockReadOf(w, "CPGT"))
        assert.deepStrictEqual(
          stock.filter(([, , custodian]) => custodian === id),
          [["CPGT", "ARGENTUM ASIA ASSETS HONG KONG LIMITED", id, name, 2_000]]
        )
        const read = yield* custodianReadOf(w, id)
        assert.deepStrictEqual(
          read.links.map(({ code }) => code),
          ["CPGT"]
        )
      })
  )

  it.effect(
    "merges a custodian's spellings by broker code, and one without a code by its name",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // Maybank spelled another way; Citibank, no member of IDX, spelled
        // another way for a second CPGT holder.
        addAccount(w, "ASRI", 1, "MAYBANK SEKURITAS INDONESIA, PT", 1_000)
        addAccount(w, "CPGT", 7, "Citibank N.A.", 2_000)
        const asri = custodiansOf(yield* stockReadOf(w, "ASRI"))
        assert.includeDeepMembers(asri, [
          [
            "ASRI",
            "ESTATE FAJAR INDUSTRIAL TANGERANG",
            "ZP",
            "MAYBANK SEKURITAS INDONESIA",
            1_000,
          ],
          // Manunggal's two Maybank accounts, summed.
          [
            "ASRI",
            MANUNGGAL,
            "ZP",
            "MAYBANK SEKURITAS INDONESIA",
            2_350_449_800,
          ],
        ])
        const citibank = custodiansOf(yield* stockReadOf(w, "CPGT")).filter(
          ([, , id]) => id === "NAME:A CITIBANK N"
        )
        assert.deepStrictEqual(citibank, [
          [
            "CPGT",
            "ARGENTUM ASIA ASSETS HONG KONG LIMITED",
            "NAME:A CITIBANK N",
            "CITIBANK, N. A",
            2_000,
          ],
          [
            "CPGT",
            "LIMITED RECKSON",
            "NAME:A CITIBANK N",
            "CITIBANK, N. A",
            1_156_687_126,
          ],
        ])
      })
  )

  it.effect(
    "focuses a custodian on the above-5% holders holding through it, market-wide",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        addAccount(w, "ASRI", 1, "MAYBANK SEKURITAS INDONESIA, PT", 1_000)
        const read = yield* custodianReadOf(w, "ZP")
        assert.strictEqual(read.day, "2026-11-20")
        assert.deepStrictEqual(read.focus, {
          kind: "custodian",
          id: CustodianId.make("ZP"),
          broker: BrokerCode.make("ZP"),
          name: "MAYBANK SEKURITAS INDONESIA",
        })
        // Its holders' holdings through it, in ASRI and ENRG, each with its
        // move, and nothing a hop beyond.
        assert.deepStrictEqual(
          read.links.map(({ code, band, name, move }) => [
            code,
            band,
            name,
            move?.kind,
          ]),
          [
            ["ASRI", "5%", "PT TANGERANG FAJAR INDUSTRIAL ESTATE", undefined],
            ["ASRI", "5%", "PT. MANUNGGAL PRIME DEVELOPMENT", undefined],
            ["ASRI", "5%", "MAYBANK SEKURITAS INDONESIA", undefined],
            ["ENRG", "5%", "MAYBANK SEKURITAS INDONESIA", "up"],
          ]
        )
        // Nothing a hop beyond; its Off list has its own test.
        assert.deepStrictEqual(read.hops, [])
        // Its own links, and its holdings' other custodians.
        assert.deepStrictEqual(
          custodiansOf(read).filter(([, , id]) => id === "ZP"),
          [
            [
              "ASRI",
              MANUNGGAL,
              "ZP",
              "MAYBANK SEKURITAS INDONESIA",
              2_350_449_800,
            ],
            [
              "ASRI",
              "ESTATE FAJAR INDUSTRIAL TANGERANG",
              "ZP",
              "MAYBANK SEKURITAS INDONESIA",
              1_000,
            ],
            [
              "ASRI",
              MAYBANK,
              "ZP",
              "MAYBANK SEKURITAS INDONESIA",
              1_701_000_200,
            ],
            [
              "ENRG",
              MAYBANK,
              "ZP",
              "MAYBANK SEKURITAS INDONESIA",
              2_618_186_200,
            ],
          ]
        )
        assert.deepStrictEqual(
          [...new Set(custodiansOf(read).map(([, , id]) => id))],
          ["KI", "PD", "ZP"]
        )
      })
  )

  it.effect("focuses a custodian without a broker code by its name", () =>
    Effect.gen(function* () {
      const read = yield* custodianReadOf(yield* parsed, "NAME:A CITIBANK N")
      assert.deepStrictEqual(read.focus, {
        kind: "custodian",
        id: CustodianId.make("NAME:A CITIBANK N"),
        broker: undefined,
        name: "CITIBANK, N. A",
      })
      assert.deepStrictEqual(linksOf(read.links), [
        ["CPGT", "5%", "RECKSON LIMITED", 2912],
      ])
    })
  )

  it.effect(
    "lists a custodian's earlier holders as its Off list, since the day after their last",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const offListOf = (read: HolderMapRead) =>
          read.offList.map(({ code, band, holder, since }) => [
            code,
            band,
            holder,
            since,
          ])
        // A bank's accounts: ASRI's and ENRG's first blocks on 19 Nov, and
        // ENRG's on 20 Nov.
        addAccount(w, "ASRI", 1, "PT ZP", 1_000, "2026-11-19")
        addAccount(w, "ENRG", 1, "PT ZP", 1_000, "2026-11-19")
        addAccount(w, "ENRG", 1, "PT ZP", 1_000)
        // Tangerang held ASRI through it on 19 Nov and not on 20 Nov; ENRG's
        // holder still does.
        assert.deepStrictEqual(
          offListOf(yield* custodianReadOf(w, "NAME:ZP")),
          [["ASRI", "5%", "ESTATE FAJAR INDUSTRIAL TANGERANG", "2026-11-20"]]
        )
        // As of 19 Nov, both held through it.
        assert.deepStrictEqual(
          offListOf(yield* custodianReadOf(w, "NAME:ZP", "2026-11-19")),
          []
        )
      })
  )

  it.effect(
    "holds nothing through an account emptied to zero shares, now or earlier",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const offListOf = (read: HolderMapRead) =>
          read.offList.map(({ code, holder, since }) => [code, holder, since])
        // A bank's accounts: Tangerang's ASRI block held 1,000 shares there
        // on 19 Nov, emptied to 0 by 20 Nov; Shima's ENRG account was
        // already empty on 19 Nov and holds 1,000 on 20 Nov.
        addAccount(w, "ASRI", 1, "PT ZP", 1_000, "2026-11-19")
        addAccount(w, "ASRI", 1, "PT ZP", 0)
        addAccount(w, "ENRG", 13, "PT ZP", 0, "2026-11-19")
        addAccount(w, "ENRG", 11, "PT ZP", 1_000)
        const shima = HolderKey.make(
          yield* holderKey("PT Shima Global Kapital")
        )
        const read = yield* custodianReadOf(w, "NAME:ZP")
        // Only Shima's ENRG block is held through it on 20 Nov: no link, no
        // book line and no node for the emptied account.
        assert.deepStrictEqual(
          custodiansOf(read).filter(([, , id]) => id === "NAME:ZP"),
          [["ENRG", shima, "NAME:ZP", "PT ZP", 1_000]]
        )
        assert.deepStrictEqual(
          read.links.map(({ code }) => code),
          ["ENRG"]
        )
        const view = (yield* holderMapView(read)).focus
        assert.deepStrictEqual(
          view?.kind === "custodian"
            ? view.book.holders.map(({ key, shares, stocks }) => [
                key,
                shares,
                stocks,
              ])
            : undefined,
          [[shima, 1_000, [StockCode.make("ENRG")]]]
        )
        // Tangerang left it on 20 Nov; Shima, empty there on 19 Nov, never
        // held through it before.
        assert.deepStrictEqual(offListOf(read), [
          ["ASRI", "ESTATE FAJAR INDUSTRIAL TANGERANG", "2026-11-20"],
        ])
        // As of 19 Nov, only Tangerang held through it.
        const nov19 = yield* custodianReadOf(w, "NAME:ZP", "2026-11-19")
        assert.deepStrictEqual(
          nov19.links.map(({ code }) => code),
          ["ASRI"]
        )
        assert.deepStrictEqual(offListOf(nov19), [])
        // A stock focus links no holder to it through an empty account.
        assert.deepStrictEqual(
          custodiansOf(yield* stockReadOf(w, "ASRI")).filter(
            ([, , id]) => id === "NAME:ZP"
          ),
          []
        )
      })
  )

  it.effect(
    "draws nothing earlier through a custodian with no earlier holders",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        assert.deepStrictEqual(
          (yield* custodianReadOf(w, "NAME:A CITIBANK N")).offList,
          []
        )
      })
  )

  it.effect(
    "keeps a custodian named like a broker code apart from that broker",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // A bank no exchange member is, whose name's key is ZP.
        addAccount(w, "ASRI", 1, "PT ZP", 2_000)
        const broker = yield* custodianReadOf(w, "ZP")
        assert.notInclude(
          broker.custodians.map(({ shares }) => shares),
          2_000
        )
        const named = yield* custodianReadOf(w, "NAME:ZP")
        assert.deepStrictEqual(named.focus, {
          kind: "custodian",
          id: CustodianId.make("NAME:ZP"),
          broker: undefined,
          name: "PT ZP",
        })
        assert.deepStrictEqual(
          custodiansOf(named).filter(([, , id]) => id === "NAME:ZP"),
          [
            [
              "ASRI",
              "ESTATE FAJAR INDUSTRIAL TANGERANG",
              "NAME:ZP",
              "PT ZP",
              2_000,
            ],
          ]
        )
      })
  )

  it.effect("finds nothing for a custodian with no account that day", () =>
    Effect.gen(function* () {
      const read = yield* custodianReadOf(yield* parsed, "ZZ", "2026-06-25")
      assert.strictEqual(read.day, "2026-06-25")
      assert.deepStrictEqual(read.focus, {
        kind: "custodian",
        id: CustodianId.make("ZZ"),
        broker: undefined,
        name: undefined,
      })
      assert.deepStrictEqual(
        [read.links, read.hops, read.custodians],
        [[], [], []]
      )
    })
  )
})

// CPGT lists two blocks of one key, ASIA ARGENTUM ASSETS HONG KONG LIMITED
// at 8.17% (Deutsche Bank) and 20.95% (Trimegah): every part of the map
// that turns blocks into a holder shows the one holder at their 29.12%.
describe("Holder map, one key's blocks", () => {
  const ARGENTUM = "ASIA ARGENTUM ASSETS HONG KONG LIMITED"
  const DEUTSCHE = "BUT DEUTSCHE BANK AG"
  const TRIMEGAH = "PT. TRIMEGAH SEKURITAS INDONESIA TBK"
  const BOTH = 2912

  // Each read's holdings of Argentum's key in CPGT: links, hops, Off list
  // and custodian links, as [where, %] or [where, shares].
  const argentumIn = Effect.fnUntraced(function* (read: HolderMapRead) {
    const key = yield* holderKey(ARGENTUM)
    const mine = <H extends { readonly code: string; readonly holder: string }>(
      of: ReadonlyArray<H>
    ) => of.filter(({ code, holder }) => code === "CPGT" && holder === key)
    return {
      links: mine(read.links).map(({ band, percentageHundredths }) => [
        band,
        percentageHundredths,
      ]),
      hops: mine(read.hops).map(({ band, percentageHundredths }) => [
        band,
        percentageHundredths,
      ]),
      offList: mine(read.offList).map(
        ({ band, percentageHundredths, since }) => [
          band,
          percentageHundredths,
          since,
        ]
      ),
      custodians: mine(read.custodians).map(({ name, shares }) => [
        name,
        shares,
      ]),
    }
  })

  const custodianIdOf = (spelling: string) =>
    Effect.map(custodianOf(spelling), ({ id }) => id)

  it.effect(
    "draws the key as one holder at its blocks' sum in every focus",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const atBoth = [["5%", BOTH]]
        // Stock focus: a link; the other holder's focus: a hop; its own
        // focus: a link; each custodian's focus: a link.
        const stock = yield* argentumIn(yield* stockReadOf(w, "CPGT"))
        assert.deepStrictEqual(stock.links, atBoth)
        assert.deepStrictEqual(
          stock.custodians.map(([, shares]) => shares),
          [832_312_874, 324_374_252]
        )
        const reckson = yield* argentumIn(
          yield* holderReadOf(w, "RECKSON LIMITED")
        )
        assert.deepStrictEqual(reckson.hops, atBoth)
        assert.deepStrictEqual(
          (yield* argentumIn(yield* holderReadOf(w, ARGENTUM))).links,
          atBoth
        )
        for (const spelling of [DEUTSCHE, TRIMEGAH])
          assert.deepStrictEqual(
            (yield* argentumIn(
              yield* custodianReadOf(w, yield* custodianIdOf(spelling))
            )).links,
            atBoth
          )
      })
  )

  it.effect(
    "lists the key Off list at its blocks' summed last stake when they leave together",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // 20 Nov republished without either block: both leave that day.
        republish(w, "2026-11-20", "argentum-left-2026-11-20")
        yield* archive(w, "cron-2026-11-26T13")
        yield* parse(w, "cron-2026-11-26")
        const left = [["5%", BOTH, "2026-11-20"]]
        const stock = yield* argentumIn(yield* stockReadOf(w, "CPGT"))
        assert.deepStrictEqual([stock.links, stock.offList], [[], left])
        const holder = yield* argentumIn(yield* holderReadOf(w, ARGENTUM))
        assert.deepStrictEqual([holder.links, holder.offList], [[], left])
        // Trimegah, which it held a block through, lists the holding at the
        // key's last stake, not its block's. Deutsche Bank holds no account
        // on 20 Nov, so that day knows no spelling of it to focus.
        const trimegah = yield* argentumIn(
          yield* custodianReadOf(w, yield* custodianIdOf(TRIMEGAH))
        )
        assert.deepStrictEqual([trimegah.links, trimegah.offList], [[], left])
        const deutsche = yield* custodianReadOf(
          w,
          yield* custodianIdOf(DEUTSCHE)
        )
        assert.deepStrictEqual(deutsche.links, [])
      })
  )

  it.effect(
    "lists the key Off list at a custodian its one block left at its summed last stake",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // 20 Nov republished without the Trimegah block: the key stays
        // listed through Deutsche Bank alone.
        republish(w, "2026-11-20", "argentum-gone-2026-11-20")
        yield* archive(w, "cron-2026-11-26T13")
        yield* parse(w, "cron-2026-11-26")
        const trimegah = yield* argentumIn(
          yield* custodianReadOf(w, yield* custodianIdOf(TRIMEGAH))
        )
        assert.deepStrictEqual(
          [trimegah.links, trimegah.offList],
          [[], [["5%", BOTH, "2026-11-20"]]]
        )
        const deutsche = yield* argentumIn(
          yield* custodianReadOf(w, yield* custodianIdOf(DEUTSCHE))
        )
        assert.deepStrictEqual(
          [deutsche.links, deutsche.offList],
          [[["5%", 817]], []]
        )
      })
  )

  it.effect(
    "lists no key at part of its leavings when the Off list is cut through them",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        // A day CPGT lost more holders than an Off list keeps: two blocks
        // of one key, `A Z` and `Z A`, with 8,000 others between them by
        // name (codex review of apinrdw/kumora#741, round 4).
        const leaving = w.holdings.database.prepare(
          `INSERT INTO above_5_move VALUES ('2026-06-10', 'CPGT', ?, 'CPGT',
            ?, '[]', NULL, 'off list', '[]', NULL, 600, NULL, NULL, '[]',
            NULL)`
        )
        const names = [
          "A Z",
          ...Array.from(
            { length: 8_000 },
            (_, at) => `M ${String(at).padStart(4, "0")}`
          ),
          "Z A",
        ]
        names.forEach((name, at) => leaving.run(`LEFT ${at}#1`, name))
        const read = yield* stockReadOf(w, "CPGT")
        const key = yield* holderKey("A Z")
        // The key at both blocks' 12%, or left out whole: never at 6%.
        assert.deepStrictEqual(
          read.offList
            .filter(({ holder }) => holder === key)
            .map(({ percentageHundredths }) => percentageHundredths)
            .filter((hundredths) => hundredths !== 1200),
          []
        )
        assert.isTrue(read.offListCut)
      })
  )

  // Two blocks of PT CONTOH in a stock of its own on 19 and 20 Nov, each
  // a block of one account, and the lines Holder moves stores of each
  // block on 20 Nov (codex review of apinrdw/kumora#741, round 7).
  const HSBC = "THE HONGKONG AND SHANGHAI BANKING CORP. LTD"
  const PROFINDO = "PT PROFINDO SEKURITAS INDONESIA"
  interface Block {
    readonly custodian: string
    readonly shares: number
    readonly hundredths: number
  }
  const contohOf = Effect.fnUntraced(function* (
    w: World,
    days: Readonly<Record<"2026-11-19" | "2026-11-20", ReadonlyArray<Block>>>
  ) {
    const db = w.holdings.database
    const key = yield* holderKey("PT CONTOH")
    const block = db.prepare(
      `INSERT INTO above_5_holder VALUES (?, 'CNTH', ?, 'CONTOH TBK',
        'PT CONTOH', ?, ?, ?)`
    )
    const account = db.prepare(
      `INSERT INTO above_5_account VALUES (?, 'CNTH', ?, 1, ?, 'PT CONTOH',
        'local', NULL, NULL, ?)`
    )
    for (const [day, blocks] of Object.entries(days))
      blocks.forEach(({ custodian, shares, hundredths }, at) => {
        block.run(day, at + 1, key, shares, hundredths)
        account.run(day, at + 1, custodian, shares)
      })
    const line = db.prepare(
      `INSERT INTO above_5_move VALUES ('2026-11-20', 'CNTH', ?,
        'CONTOH TBK', 'PT CONTOH', '[]', NULL, ?, '[]', ?, ?, ?, ?, '[]',
        NULL)`
    )
    const before = days["2026-11-19"]
    days["2026-11-20"].forEach((held, at) => {
      const last = before[at]
      if (last === undefined || last.shares === held.shares) return
      line.run(
        `${key}#${at + 1}`,
        held.shares > last.shares ? "up" : "down",
        held.shares - last.shares,
        last.hundredths,
        held.hundredths,
        held.hundredths - last.hundredths
      )
    })
    const [above5] = (yield* mapOf(w, "CNTH")).focus?.bands ?? []
    return above5?.holders.map(({ name, move }) => [name, move])
  })

  it.effect(
    "moves a key whose shares crossed custodians between its blocks as a Transfer",
    () =>
      Effect.gen(function* () {
        // 200 shares left the HSBC block for the Profindo block: the key's
        // total is unchanged, held through someone else.
        assert.deepStrictEqual(
          yield* contohOf(yield* parsed, {
            "2026-11-19": [
              { custodian: HSBC, shares: 1_000, hundredths: 1000 },
              { custodian: PROFINDO, shares: 2_000, hundredths: 2000 },
            ],
            "2026-11-20": [
              { custodian: HSBC, shares: 800, hundredths: 800 },
              { custodian: PROFINDO, shares: 2_200, hundredths: 2200 },
            ],
          }),
          [
            [
              "PT CONTOH",
              { kind: "transfer", shareChange: 0, percentageChange: 0 },
            ],
          ]
        )
      })
  )

  it.effect(
    "changes a key's % by every block's, an unchanged block's too",
    () =>
      Effect.gen(function* () {
        // Listed shares doubled: the unchanged block went 12% → 6%, the
        // other 2,000 → 2,200 shares and 20% → 11%: 32% → 17%.
        assert.deepStrictEqual(
          yield* contohOf(yield* parsed, {
            "2026-11-19": [
              { custodian: HSBC, shares: 1_200, hundredths: 1200 },
              { custodian: PROFINDO, shares: 2_000, hundredths: 2000 },
            ],
            "2026-11-20": [
              { custodian: HSBC, shares: 1_200, hundredths: 600 },
              { custodian: PROFINDO, shares: 2_200, hundredths: 1100 },
            ],
          }),
          [
            [
              "PT CONTOH",
              { kind: "up", shareChange: 200, percentageChange: -1500 },
            ],
          ]
        )
      })
  )
  it.effect(
    "gives a key of several blocks New only when its stock was listed the day before",
    () =>
      Effect.gen(function* () {
        const blocks = [
          { custodian: HSBC, shares: 1_000, hundredths: 1000 },
          { custodian: PROFINDO, shares: 2_000, hundredths: 2000 },
        ]
        // The stock's first listed day: Holder moves compares nothing.
        assert.deepStrictEqual(
          yield* contohOf(yield* parsed, {
            "2026-11-19": [],
            "2026-11-20": blocks,
          }),
          [["PT CONTOH", undefined]]
        )
        const w = yield* parsed
        w.holdings.database
          .prepare(
            `INSERT INTO above_5_holder VALUES ('2026-11-19', 'CNTH', 9,
              'CONTOH TBK', 'PT LAIN', 'LAIN', 500, 500)`
          )
          .run()
        assert.deepStrictEqual(
          yield* contohOf(w, { "2026-11-19": [], "2026-11-20": blocks }),
          [
            [
              "PT CONTOH",
              { kind: "new", shareChange: 3_000, percentageChange: undefined },
            ],
          ]
        )
      })
  )

  it.effect(
    "folds the day before's repeat of another key's block as the day's",
    () =>
      Effect.gen(function* () {
        // On 19 and 20 Nov alike: PT ALPHA's block, a PT BETA-named repeat
        // of it, and PT BETA's own block. Folded on both days, PT BETA
        // holds its own 2,000 shares unchanged (codex review of
        // apinrdw/kumora#741, round 10).
        const w = yield* parsed
        const db = w.holdings.database
        const block = db.prepare(
          `INSERT INTO above_5_holder VALUES (?, 'CNTH', ?, 'CONTOH TBK',
            ?, ?, ?, ?)`
        )
        const account = db.prepare(
          `INSERT INTO above_5_account VALUES (?, 'CNTH', ?, 1, ?, ?,
            'local', NULL, NULL, ?)`
        )
        const blocks = [
          ["PT ALPHA", HSBC, "PT ALPHA", 1_000],
          ["PT BETA", HSBC, "PT ALPHA", 1_000],
          ["PT BETA", PROFINDO, "PT BETA", 2_000],
        ] as const
        for (const day of ["2026-11-19", "2026-11-20"])
          for (const [
            at,
            [name, custodian, holds, shares],
          ] of blocks.entries()) {
            block.run(day, at + 1, name, yield* holderKey(name), shares, shares)
            account.run(day, at + 1, custodian, holds, shares)
          }
        const [above5] = (yield* mapOf(w, "CNTH")).focus?.bands ?? []
        assert.deepStrictEqual(
          above5?.holders.map(({ name, shares, move }) => [name, shares, move]),
          [
            ["PT BETA", 2_000, undefined],
            ["PT ALPHA", 1_000, undefined],
          ]
        )
      })
  )
})

describe("Holder map, a repeat block of another key", () => {
  // ASRI's later Manunggal blocks of 19 Nov repeat its first (the same
  // accounts and shares): under another name, so another key, they still
  // fold into the first (codex review of apinrdw/kumora#741, round 8).
  const DAY = "2026-11-19"
  const ALIAS = "MANUNGGAL PRIME DEVELOPMENT HOLDINGS LTD"
  const renamed = Effect.gen(function* () {
    const w = yield* parsed
    w.holdings.database
      .prepare(
        `UPDATE above_5_holder SET holder_name = ?2, holder_key = ?3
          WHERE stock_code = 'ASRI' AND data_date = ?1 AND holder_key = ?4
            AND no > (
              SELECT MIN(no) FROM above_5_holder
              WHERE stock_code = 'ASRI' AND data_date = ?1 AND holder_key = ?4
            )`
      )
      .run(DAY, ALIAS, yield* holderKey(ALIAS), MANUNGGAL)
    return w
  })

  it.effect("searches the holder by the key the map draws it under", () =>
    Effect.gen(function* () {
      const w = yield* renamed
      const { holders } = yield* holderMapSearchList(WibDate.make(DAY)).pipe(
        Effect.provide(w.holdings.layer)
      )
      const keys = holders.map(({ key }) => key)
      assert.include(keys, HolderKey.make(MANUNGGAL))
      assert.notInclude(keys, HolderKey.make(yield* holderKey(ALIAS)))
    })
  )

  it.effect("focuses the holder it folds into on its own key", () =>
    Effect.gen(function* () {
      const read = yield* holderReadOf(yield* renamed, ALIAS, DAY)
      assert.deepInclude(read.focus, {
        kind: "holder",
        key: HolderKey.make(MANUNGGAL),
      })
      assert.deepStrictEqual(
        linksOf(read.links).map(([code, band, , hundredths]) => [
          code,
          band,
          hundredths,
        ]),
        [["ASRI", "5%", 2103]]
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

  it.effect(
    "searches every stock of the newest day's and month's reports",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const { stocks } = yield* holderMapSearchList(undefined).pipe(
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

  it.effect(
    "searches every holder of the newest day's and month's reports, once a key",
    () =>
      Effect.gen(function* () {
        const { holders } = yield* holderMapSearchList(undefined).pipe(
          Effect.provide((yield* parsed).holdings.layer)
        )
        const keys = holders.map(({ key }) => key)
        assert.strictEqual(new Set(keys).size, keys.length)
        assert.deepInclude(holders, {
          key: HolderKey.make("DJS HARI JAMINAN KETENAGAKERJAAN PROGRAM TUA"),
          name: BPJS,
        })
        // Agung, in both of TRUE's reports, is one holder.
        assert.lengthOf(
          holders.filter(({ name }) => name.includes("AGUNG PERKASA")),
          1
        )
        // Djoni left every list before Oct.
        assert.notInclude(keys, HolderKey.make("DJONI"))
      })
  )

  it.effect(
    "searches the holders of the day in view and its month, not the newest",
    () =>
      Effect.gen(function* () {
        const { holders } = yield* holderMapSearchList(
          WibDate.make("2026-06-25")
        ).pipe(Effect.provide((yield* parsed).holdings.layer))
        // Djoni was still a ≥1% holder of TRUE in Apr, the month of 25 Jun.
        assert.include(
          holders.map(({ key }) => key),
          HolderKey.make("DJONI")
        )
      })
  )

  it.effect(
    "searches every custodian of the newest day, once each, by name",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        addAccount(w, "ASRI", 1, "MAYBANK SEKURITAS INDONESIA, PT", 1_000)
        const { custodians } = yield* holderMapSearchList(undefined).pipe(
          Effect.provide(w.holdings.layer)
        )
        const ids = custodians.map(({ id }) => id)
        assert.strictEqual(new Set(ids).size, ids.length)
        assert.includeDeepMembers(custodians, [
          {
            id: "ZP",
            broker: "ZP",
            name: "MAYBANK SEKURITAS INDONESIA",
          },
          {
            id: "NAME:A CITIBANK N",
            broker: undefined,
            name: "CITIBANK, N. A",
          },
        ])
        const names = custodians.map(({ name }) => name)
        assert.deepStrictEqual(names, [...names].sort())
      })
  )
})

describe("Holder map, as-of day", () => {
  it.effect("lists every above-5% day to pick from, oldest first", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, "TRUE", "2026-06-25")
      assert.deepStrictEqual<ReadonlyArray<string>>(map.days, [
        "2026-06-11",
        "2026-06-12",
        "2026-06-24",
        "2026-06-25",
        "2026-11-19",
        "2026-11-20",
      ])
      assert.isUndefined(map.refused)
    })
  )

  it.effect("refuses a day without an above-5% report, keeping the focus", () =>
    Effect.gen(function* () {
      // A Saturday: IDX publishes no above-5% report.
      const map = yield* mapOf(yield* parsed, "TRUE", "2026-06-13")
      assert.strictEqual(map.refused, "2026-06-13")
      assert.isUndefined(map.day)
      assert.isUndefined(map.month)
      assert.strictEqual(map.focus?.title, "TRUE")
      assert.deepStrictEqual(map.focus?.bands, [])
      assert.lengthOf(map.days, 6)
    })
  )

  it.effect("refuses a day without a report on the landing view too", () =>
    Effect.gen(function* () {
      const map = yield* mapOf(yield* parsed, undefined, "2026-06-13")
      assert.strictEqual(map.refused, "2026-06-13")
      assert.deepStrictEqual(map.mostHeld, [])
    })
  )

  it.effect("draws the 5% band only for a day before any above-1% month", () =>
    Effect.gen(function* () {
      // August's report is the first above-1% month parsed, after June's
      // trading days.
      const w: World = {
        idx: fakeIdx([
          ...above5Items(),
          ...listedSharesItems(),
          above1Item("2026-08-31"),
          above1Item("2026-10-30"),
        ]),
        bucket: memoryBucket(),
        holdings: memoryHoldingsDb(),
      }
      yield* archiveAndParse(w, "cron-2026-11-25")
      yield* runParse(above1ParseRuns)(w, "cron-2026-11-25")
      const map = yield* mapOf(w, "TRUE", "2026-06-25")
      assert.strictEqual(map.day, "2026-06-25")
      assert.isUndefined(map.month)
      assert.deepStrictEqual(
        map.focus?.bands.map(({ band }) => band),
        ["5%"]
      )
      assert.deepStrictEqual(
        rowsOf(map.focus?.bands[0]).map(([name, hundredths]) => [
          name,
          hundredths,
        ]),
        [["PT AGUNG PERKASA INVESTINDO", 5283]]
      )
      // A later day takes the newest month on or before it.
      const later = yield* mapOf(w, "TRUE", "2026-11-19")
      assert.strictEqual(later.month, "2026-10-30")
    })
  )
})

describe("Holder map, a bad stored row", () => {
  // The parsers only trim a code and cap its length, so a report can store
  // a code that isn't a stock code's shape, and a name of legal-form words
  // only keys to nothing: no read fails on either, it leaves the row out
  // (codex review of apinrdw/kumora#741, round 9).
  const BAD = "BAD CODE"
  const BLANK = "PT TBK"
  const withBadRows = Effect.gen(function* () {
    const w = yield* parsed
    const db = w.holdings.database
    const agung = yield* holderKey("PT AGUNG PERKASA INVESTINDO")
    const { custodian } = db
      .prepare(
        `SELECT custodian FROM above_5_account
          WHERE stock_code = 'TRUE' AND data_date = '2026-11-20' LIMIT 1`
      )
      .get() as { custodian: string }
    const block = db.prepare(
      `INSERT INTO above_5_holder VALUES (?, ?, ?, 'BAD TBK', ?, ?, 1000, 600)`
    )
    const account = db.prepare(
      `INSERT INTO above_5_account VALUES (?, ?, ?, 1, ?, 'ACCOUNT',
        'local', NULL, NULL, 1000)`
    )
    // Held on 20 Nov: a block of Agung under a bad code, and one of TRUE
    // under a blank key, both through TRUE's custodian.
    for (const [day, code, no, name, key] of [
      ["2026-11-20", BAD, 1, "PT AGUNG PERKASA INVESTINDO", agung],
      ["2026-11-20", "TRUE", 98, BLANK, ""],
      // Left before 20 Nov, through that custodian: its earlier holdings.
      ["2026-11-19", BAD, 1, "PT BAD HOLDER", "BAD HOLDER"],
      ["2026-11-19", "TLKM", 98, BLANK, ""],
    ] as const) {
      block.run(day, code, no, name, key)
      account.run(day, code, no, custodian)
    }
    const month = db.prepare(
      `INSERT INTO above_1_holding VALUES ('2026-10-30', ?, 998, 'BAD TBK',
        ?, ?, NULL, 'CP', 'local', NULL, NULL, NULL, 2000000, 0, 2000000,
        200)`
    )
    month.run(BAD, "PT AGUNG PERKASA INVESTINDO", agung)
    month.run("TLKM", BLANK, "")
    const line = db.prepare(
      `INSERT INTO above_5_move VALUES ('2026-11-20', ?, ?, 'BAD TBK', ?,
        '[]', NULL, ?, '[]', NULL, ?, ?, NULL, '[]', NULL)`
    )
    line.run(BAD, `${agung}#1`, "PT AGUNG PERKASA INVESTINDO", "new", null, 600)
    line.run(
      BAD,
      `${agung}#2`,
      "PT AGUNG PERKASA INVESTINDO",
      "off list",
      600,
      null
    )
    line.run("TRUE", "#1", BLANK, "new", null, 600)
    line.run("TRUE", "#2", BLANK, "off list", 600, null)
    return w
  })

  it.effect("searches the stocks and holders, the bad rows left out", () =>
    Effect.gen(function* () {
      const w = yield* withBadRows
      const { stocks, holders } = yield* holderMapSearchList(undefined).pipe(
        Effect.provide(w.holdings.layer)
      )
      assert.notInclude(
        stocks.map(({ code }): string => code),
        BAD
      )
      const keys = holders.map(({ key }): string => key)
      assert.include(keys, HolderKey.make(AGUNG))
      assert.notInclude(keys, "")
    })
  )

  it.effect("draws a stock focus, its Off list and the stocks most held", () =>
    Effect.gen(function* () {
      const w = yield* withBadRows
      const read = yield* stockReadOf(w, "TRUE")
      assert.include(
        read.links.map(({ holder }): string => holder),
        HolderKey.make(AGUNG)
      )
      assert.notInclude(
        read.offList.map(({ holder }): string => holder),
        ""
      )
      const map = yield* mapOf(w, undefined)
      assert.notInclude(
        map.mostHeld.map(({ code }): string => code),
        BAD
      )
    })
  )

  it.effect(
    "ranks the stocks most held by the holders their maps draw, bad rows taking no place",
    () =>
      Effect.gen(function* () {
        const w = yield* withBadRows
        // Twenty stocks under bad codes, each of twenty month holders: more
        // than any real stock, and as many as the landing view lists.
        const month = w.holdings.database.prepare(
          `INSERT INTO above_1_holding VALUES ('2026-10-30', ?, ?, 'BAD TBK',
            ?, ?, NULL, 'CP', 'local', NULL, NULL, NULL, 2000000, 0,
            2000000, 200)`
        )
        for (let stock = 1; stock <= 20; stock++)
          for (let holder = 1; holder <= 20; holder++)
            month.run(
              `BAD ${stock}`,
              holder,
              `HOLDER ${holder}`,
              `${holder} HOLDER`
            )
        const map = yield* mapOf(w, undefined)
        // TLKM's blank-key row is no holder: its map draws five.
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

  it.effect("draws a holder focus with its hops and Off list", () =>
    Effect.gen(function* () {
      const read = yield* holderReadOf(
        yield* withBadRows,
        "PT AGUNG PERKASA INVESTINDO"
      )
      assert.include(
        read.links.map(({ code }): string => code),
        "TRUE"
      )
      assert.notInclude(
        [...read.links, ...read.hops, ...read.offList].map(
          ({ code }): string => code
        ),
        BAD
      )
    })
  )

  it.effect("draws a custodian focus with its Off list", () =>
    Effect.gen(function* () {
      const read = yield* custodianReadOf(yield* withBadRows, "YP")
      assert.include(
        read.links.map(({ code }): string => code),
        "TRUE"
      )
      const codes = [...read.links, ...read.offList].map(
        ({ code }): string => code
      )
      assert.notInclude(codes, BAD)
      assert.notInclude(
        [...read.links, ...read.offList].map(({ holder }): string => holder),
        ""
      )
    })
  )
})
