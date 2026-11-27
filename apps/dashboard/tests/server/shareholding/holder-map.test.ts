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

// One more securities account of a block of 20 Nov 2026.
const addAccount = (
  w: World,
  code: string,
  no: number,
  custodian: string,
  shares: number
) =>
  w.holdings.database
    .prepare(
      `INSERT INTO above_5_account VALUES ('2026-11-20', ?, ?, 99, ?,
        'ACCOUNT', 'local', NULL, NULL, ?)`
    )
    .run(code, no, custodian, shares)

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
        assert.deepStrictEqual(read.hops, [])
        assert.deepStrictEqual(read.offList, [])
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
        const { stocks } = yield* holderMapSearchList.pipe(
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
        const { holders } = yield* holderMapSearchList.pipe(
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
    "searches every custodian of the newest day, once each, by name",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        addAccount(w, "ASRI", 1, "MAYBANK SEKURITAS INDONESIA, PT", 1_000)
        const { custodians } = yield* holderMapSearchList.pipe(
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
