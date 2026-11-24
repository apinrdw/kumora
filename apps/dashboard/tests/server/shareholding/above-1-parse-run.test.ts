// The Above-1% parse run: the shareholding archive's holders-above-1%
// reports parsed into ≥1% holders.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { majorHolders as monthHolders } from "@/lib/major-holders"
import { RunId } from "@/server/archive/run"
import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { stockPage } from "@/server/holdings/stock-page"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"
import { archiveRun } from "@/server/shareholding/archive-run"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  type Above1Fixture,
  above1Fixture,
  above1Item,
  above1Items,
  type BrokenAbove1Fixture,
  type FakeIdx,
  type SplitAbove1Fixture,
  fakeIdx,
  idxIdUrl,
  investorTypeItems,
} from "./fake-idx.ts"
import { localSteps } from "../archive/local-steps.ts"
import { archiveDbOf, shareholdingParse, storedRun } from "../archive/runs.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  type MemoryHoldingsDb,
  memoryHoldingsDb,
} from "../holdings/memory-holdings-db.ts"

interface World {
  readonly idx: FakeIdx
  readonly bucket: MemoryBucket
  readonly holdings: MemoryHoldingsDb
}

// IDX listing the above-1% fixtures' reports, and the investor-type
// fixtures' when `withInvestorType`.
const world = (withInvestorType = false): World => ({
  idx: fakeIdx([
    ...above1Items(),
    ...(withInvestorType ? investorTypeItems() : []),
  ]),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const archive = ({ idx, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      archiveRun(
        localSteps(
          Layer.mergeAll(idx.layer, bucket.layer, archiveDbOf(bucket).layer)
        ),
        {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T13:00:00Z"),
        }
      )
    )
  )

const runParse =
  (runs: typeof above1ParseRuns | typeof investorTypeParseRuns) =>
  ({ bucket, holdings }: World, id: string) =>
    TestClock.adjust("1 hour").pipe(
      Effect.andThen(
        runs.run(
          localSteps(
            Layer.mergeAll(
              bucket.layer,
              holdings.layer,
              archiveDbOf(bucket).layer
            )
          ),
          {
            id: RunId.make(id),
            trigger: "cron",
            startedAt: new Date("2026-11-14T14:00:00Z"),
          }
        )
      )
    )

const parse = runParse(above1ParseRuns)

// IDX replaces a month's report in place with a fixture's bytes.
const republish = (
  { idx }: World,
  dataDate: Above1Fixture,
  fixture: Above1Fixture | BrokenAbove1Fixture | SplitAbove1Fixture
) => {
  idx.files.set(idxIdUrl(above1Item(dataDate).Prospectus), {
    body: above1Fixture(fixture),
    etag: `"etag-${dataDate}:${fixture}"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })
}

// A parse run's record as the admin page reads it.
const runRecord = ({ bucket }: World, kind: string, id: string) =>
  Schema.decodeUnknownSync(ParseRunResult)(
    storedRun(archiveDbOf(bucket), shareholdingParse(kind), id)
  )

// A stock's ≥1% holders of `dataDate`, as the stock page reads them.
const holdersOf = ({ holdings }: World, dataDate: string, code: string) =>
  stockPage(StockCode.make(code), undefined).pipe(
    Effect.provide(holdings.layer),
    Effect.map(
      ({ majorHolders }) =>
        majorHolders.find((month) => month.dataDate === dataDate)?.holders ?? []
    )
  )

// The holder of `dataDate`'s stock `code` with a row naming `investor`, and
// that row.
const holderNaming = Effect.fnUntraced(function* (
  w: World,
  dataDate: string,
  code: string,
  investor: string
) {
  for (const holder of yield* holdersOf(w, dataDate, code)) {
    const row = holder.rows.find(({ name }) => name === investor)
    if (row !== undefined) return { ...holder, row }
  }
  return assert.fail(`${code} ${investor}`)
})

// A stock's published rows of `dataDate`, holder by holder.
const rowsOf = (w: World, dataDate: string, code: string) =>
  Effect.map(holdersOf(w, dataDate, code), (holders) =>
    holders.flatMap(({ rows }) => rows)
  )

describe("an above-1% parse run", () => {
  it.effect("parses every archived above-1% month on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 5,
        parseFailures: [],
      })
      assert.deepStrictEqual(runRecord(w, "above-1", "cron-2026-11-14"), result)

      // Feb 2026: a KSEI type and no classification, a padded `L` local and
      // `A` foreign.
      const permadi = yield* holderNaming(
        w,
        "2026-02-27",
        "AADI",
        "IR. T. PERMADI RACHMAT"
      )
      assert.deepInclude(permadi, {
        scripless: 254_992_918,
        scrip: 0,
        total: 254_992_918,
        percentageHundredths: 327,
      })
      assert.deepStrictEqual(permadi.row, {
        name: "IR. T. PERMADI RACHMAT",
        classification: undefined,
        type: "ID",
        origin: "local",
        domicile: "INDONESIA",
        controller: undefined,
        total: 254_992_918,
        percentageHundredths: 327,
      })
      assert.deepInclude(
        (yield* holderNaming(
          w,
          "2026-02-27",
          "AADI",
          "FTAG INVESTMENT BANK LTD"
        )).row,
        { origin: "foreign", domicile: "MALAYSIA", type: "IB" }
      )
      // A special scrip account: no type, origin or domicile.
      assert.deepInclude(
        (yield* holderNaming(w, "2026-02-27", "BSDE", "PARAGA ARTAMIDA, PT"))
          .row,
        {
          type: undefined,
          origin: undefined,
          domicile: undefined,
          percentageHundredths: 3052,
        }
      )
      // TRUE's code is a boolean cell.
      assert.lengthOf(yield* rowsOf(w, "2026-02-27", "TRUE"), 6)
      // Rows kept in file order, float noise rounded: 1.1500000000000001.
      assert.deepStrictEqual(
        (yield* rowsOf(w, "2026-02-27", "AADI")).map(
          ({ percentageHundredths }) => percentageHundredths
        ),
        [4110, 1537, 583, 438, 352, 327, 204, 154, 129, 115]
      )
      // BSDE's `PARAGA ARTAMIDA, PT` and `PT PARAGA ARTAMIDA` are one holder,
      // summed, its rows in file order; `PT.  PARAGA ARTA MIDA`, spelt with
      // another word, is not. TLKM's BNY Mellon DR is not BNY Mellon.
      const paraga = yield* holderNaming(
        w,
        "2026-02-27",
        "BSDE",
        "PT PARAGA ARTAMIDA"
      )
      assert.strictEqual(paraga.percentageHundredths, 3052 + 680)
      assert.deepStrictEqual(
        paraga.rows.map(({ name }) => name),
        ["PARAGA ARTAMIDA, PT", "PT PARAGA ARTAMIDA"]
      )
      assert.strictEqual(
        paraga.total,
        paraga.rows.reduce((sum, { total }) => sum + total, 0)
      )
      assert.lengthOf(
        (yield* holderNaming(w, "2026-02-27", "BSDE", "PT.  PARAGA ARTA MIDA"))
          .rows,
        1
      )
      assert.lengthOf(yield* holdersOf(w, "2026-02-27", "TLKM"), 6)
      assert.deepInclude(
        yield* holderNaming(
          w,
          "2026-02-27",
          "TLKM",
          "THE BANK OF NEW YORK MELLON"
        ),
        { percentageHundredths: 255 }
      )
      assert.deepInclude(
        yield* holderNaming(
          w,
          "2026-02-27",
          "TLKM",
          "THE BANK OF NEW YORK MELLON DR"
        ),
        { percentageHundredths: 230 }
      )
      // A title dropped and words reordered: one holder across Feb and Apr.
      assert.strictEqual(
        (yield* holderNaming(w, "2026-02-27", "RALS", "LO KHENG  HONG. DRS"))
          .key,
        (yield* holderNaming(w, "2026-04-30", "RALS", "DRS LO KHENG HONG")).key
      )

      // Apr 2026: a classification and its type, a blank one with neither,
      // the #DIV/0! rows skipped, FLMC's missing scrip cell read as 0, and
      // RALS's duplicate kept as two rows.
      assert.deepInclude(
        (yield* holderNaming(
          w,
          "2026-04-30",
          "AADI",
          "FTAG INVESTMENT BANK LTD"
        )).row,
        {
          classification: "financial_institutional",
          type: "IB",
          origin: "foreign",
        }
      )
      assert.deepInclude(
        (yield* holderNaming(
          w,
          "2026-04-30",
          "BSDE",
          "METROPOLITAN TRANSCITIES INDONESIA, PT"
        )).row,
        { classification: undefined, type: undefined, origin: "local" }
      )
      assert.deepInclude(
        yield* holderNaming(w, "2026-04-30", "FLMC", "THERESIA INDRA WIRAWAN"),
        { scripless: 308_477_875, scrip: 0, total: 308_477_875 }
      )
      assert.strictEqual(
        (yield* holderNaming(w, "2026-04-30", "BSDE", "PT PARAGA ARTAMIDA")).row
          .percentageHundredths,
        4863
      )
      assert.deepStrictEqual(
        (yield* rowsOf(w, "2026-04-30", "RALS"))
          .filter(({ name }) => name === "PT RAMAYANA MAKMURSENTOSA")
          .map(({ classification, total, percentageHundredths }) => ({
            classification,
            total,
            percentageHundredths,
          })),
        [
          {
            classification: undefined,
            total: 3_965_000_000,
            percentageHundredths: 5588,
          },
          {
            classification: "corporate",
            total: 203_513_800,
            percentageHundredths: 287,
          },
        ]
      )
      const april: Array<number> = []
      for (const code of ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"])
        april.push((yield* rowsOf(w, "2026-04-30", code)).length)
      assert.deepStrictEqual(april, [10, 8, 13, 7, 4, 6])

      // Aug to Sep 2026: AADI's Permadi Rachmat drops his title, one holder.
      assert.strictEqual(
        (yield* holderNaming(w, "2026-08-31", "AADI", "IR. T. PERMADI RACHMAT"))
          .key,
        (yield* holderNaming(w, "2026-09-30", "AADI", "T PERMADI RACHMAT")).key
      )
      assert.deepInclude(
        (yield* holderNaming(
          w,
          "2026-09-30",
          "AADI",
          "SARATOGA INVESTAMA SEDAYA TBK"
        )).row,
        { classification: "private_bank", type: "IB" }
      )

      // Oct 2026: the controller flag, read from the shifted columns.
      const adaro = yield* holderNaming(
        w,
        "2026-10-30",
        "AADI",
        "ADARO STRATEGIC INVESTMENTS"
      )
      assert.deepInclude(adaro, {
        scripless: 3_200_142_830,
        scrip: 0,
        total: 3_200_142_830,
        percentageHundredths: 4110,
      })
      assert.deepInclude(adaro.row, {
        classification: "corporate",
        type: "CP",
        controller: "controller",
        origin: "local",
        domicile: "INDONESIA",
      })
      assert.deepInclude(
        (yield* holderNaming(w, "2026-10-30", "AADI", "T PERMADI RACHMAT")).row,
        { controller: "affiliate" }
      )
      assert.deepInclude(
        (yield* holderNaming(
          w,
          "2026-10-30",
          "AADI",
          "FTAG INVESTMENT BANK LTD"
        )).row,
        { controller: undefined, percentageHundredths: 114 }
      )
    })
  )

  it.effect(
    "gives the stock page every parsed month, a stock not in one with no holders",
    () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T13")
        yield* parse(w, "cron-2026-11-14")
        const read = (code: string) =>
          stockPage(StockCode.make(code), undefined).pipe(
            Effect.provide(w.holdings.layer),
            Effect.map(({ majorHolders }) =>
              majorHolders.map(({ dataDate, holders }) => ({
                dataDate,
                holders: holders.length,
              }))
            )
          )
        assert.deepStrictEqual(yield* read("AADI"), [
          { dataDate: "2026-02-27", holders: 10 },
          { dataDate: "2026-04-30", holders: 10 },
          { dataDate: "2026-08-31", holders: 10 },
          { dataDate: "2026-09-30", holders: 10 },
          { dataDate: "2026-10-30", holders: 10 },
        ])
        assert.isTrue(
          (yield* read("BBCA")).every(({ holders }) => holders === 0)
        )
      })
  )

  it.effect("parses nothing when nothing changed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      yield* parse(w, "cron-2026-11-14")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 0 })
    })
  )

  it.effect("replaces a month with its republished version", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")

      republish(w, "2026-10-30", "2026-02-27")
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // October now reads exactly as the republished file: no old row left.
      for (const code of ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"])
        assert.deepStrictEqual(
          yield* holdersOf(w, "2026-10-30", code),
          yield* holdersOf(w, "2026-02-27", code)
        )
    })
  )

  it.effect(
    "reads Up, Down and Unchanged by the change in percentage points, not shares, across a split",
    () =>
      Effect.gen(function* () {
        const w = world()
        republish(w, "2026-10-30", "split")
        yield* archive(w, "cron-2026-11-14T13")
        yield* parse(w, "cron-2026-11-14")
        const { majorHolders: months } = yield* stockPage(
          StockCode.make("AADI"),
          undefined
        ).pipe(Effect.provide(w.holdings.layer))
        const october = yield* monthHolders(months, "2026-10")
        const changes = Object.fromEntries(
          (october?.listed ?? []).map((line) => [
            line.name,
            [line.change, line.ppChange, line.shareChange],
          ])
        )
        assert.deepInclude(changes, {
          "ADARO STRATEGIC INVESTMENTS": ["unchanged", 0, 12_800_571_320],
          "GARIBALDI THOHIR": ["down", -12, 1_816_046_428],
          "EDWIN SOERYADJAYA": ["up", 8, 1_095_822_544],
        })
      })
  )

  it.effect("parses every month again when the parser's version changes", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")
      w.holdings.database
        .prepare("UPDATE above_1_month SET parser_version = parser_version - 1")
        .run()
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 5 })
    })
  )

  it.effect("fails when it can't read which months were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM above_1_month"))
      const failure = yield* Effect.flip(parse(w, "cron-2026-11-14"))
      assert.strictEqual(failure._tag, "StepFailed")
      assert.deepInclude(runRecord(w, "above-1", "cron-2026-11-14"), {
        outcome: "failed",
        error: failure.message,
        monthsParsed: 0,
      })
    })
  )
})

describe("an above-1% report that doesn't match what's expected", () => {
  const cases: ReadonlyArray<{
    readonly what: string
    readonly fixture: BrokenAbove1Fixture
    readonly reason: string
  }> = [
    {
      what: "a header that matches no layout",
      fixture: "unknown-header",
      reason: "Header row 5's M isn't PERCENTAGE: PERCENT",
    },
    {
      what: "a share count that isn't a number",
      fixture: "text-shares",
      reason:
        "AADI (row 6)'s HOLDINGS_SCRIPLESS isn't a share count: 119.887.170",
    },
    {
      what: "an error in a cell it reads",
      fixture: "error-shares",
      reason: "AADI (row 6)'s HOLDINGS_SCRIPLESS holds the error #VALUE!",
    },
    {
      what: "a classification outside the 39",
      fixture: "unknown-classification",
      reason: "AADI (row 6)'s INVESTOR_CLASSIFICATION is unknown: Corporates",
    },
    {
      what: "no holder rows",
      fixture: "empty",
      reason: "The report has no holders",
    },
  ]

  for (const { what, fixture, reason } of cases)
    it.effect(
      `fails its month with ${what}, keeps the month's rows, and tries it again next run`,
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archive(w, "cron-2026-11-14T06")
          yield* parse(w, "cron-2026-11-14")
          const before = yield* holdersOf(w, "2026-10-30", "AADI")
          assert.lengthOf(before, 10)

          republish(w, "2026-10-30", fixture)
          yield* archive(w, "cron-2026-11-14T13")
          const failed = yield* parse(w, "cron-2026-11-15")
          assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(failed.parseFailures, [
            { date: "2026-10-30", message: reason },
          ])
          assert.deepStrictEqual(
            runRecord(w, "above-1", "cron-2026-11-15"),
            failed
          )
          assert.deepStrictEqual(
            yield* holdersOf(w, "2026-10-30", "AADI"),
            before
          )

          const retried = yield* parse(w, "cron-2026-11-16")
          assert.deepInclude(retried, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(retried.parseFailures, failed.parseFailures)
        })
    )
})

describe("the above-1% and investor-type parse runs", () => {
  const parseInvestorType = runParse(investorTypeParseRuns)

  it.effect(
    "each parse only their own kind's months, into their own records",
    () =>
      Effect.gen(function* () {
        const w = world(true)
        republish(w, "2026-10-30", "empty")
        yield* archive(w, "cron-2026-11-14T13")

        const above1 = yield* parse(w, "cron-2026-11-14")
        assert.deepInclude(above1, { outcome: "partial", monthsParsed: 4 })
        const investorType = yield* parseInvestorType(w, "cron-2026-11-14")
        assert.deepInclude(investorType, {
          outcome: "complete",
          monthsParsed: 3,
        })
        assert.deepStrictEqual(
          runRecord(w, "above-1", "cron-2026-11-14"),
          above1
        )
        assert.deepStrictEqual(
          runRecord(w, "investor-type", "cron-2026-11-14"),
          investorType
        )
      })
  )
})
