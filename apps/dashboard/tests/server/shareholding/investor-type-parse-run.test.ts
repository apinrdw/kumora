// The Investor-type parse run: the shareholding archive's investor-type
// reports parsed into investor-type holdings.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { StockCode } from "@workspace/relay"

import { RunId } from "@/server/archive/run"
import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { stockPage } from "@/server/holdings/stock-page"
import { archiveRun } from "@/server/shareholding/archive-run"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  type BrokenInvestorTypeFixture,
  classificationFixture,
  classificationItem,
  type ClassificationFixture,
  type FakeIdx,
  fakeIdx,
  idxIdUrl,
  investorTypeFixture,
  type InvestorTypeFixture,
  investorTypeItem,
  investorTypeItems,
} from "./fake-idx.ts"
import { localSteps } from "../archive/local-steps.ts"
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

// IDX listing the investor-type fixtures' reports, and the classification
// fixtures' when `withClassification`.
const world = (withClassification = false): World => ({
  idx: fakeIdx([
    ...investorTypeItems(),
    ...(withClassification
      ? (["2026-09-30", "2026-10-30"] as const).map(classificationItem)
      : []),
  ]),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const archive = ({ idx, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      archiveRun(localSteps(Layer.merge(idx.layer, bucket.layer)), {
        id: RunId.make(id),
        trigger: "cron",
        startedAt: new Date("2026-11-14T13:00:00Z"),
      })
    )
  )

const runParse =
  (runs: typeof investorTypeParseRuns | typeof classificationParseRuns) =>
  ({ bucket, holdings }: World, id: string) =>
    TestClock.adjust("1 hour").pipe(
      Effect.andThen(
        runs.run(localSteps(Layer.merge(bucket.layer, holdings.layer)), {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T14:00:00Z"),
        })
      )
    )

const parse = runParse(investorTypeParseRuns)

// IDX replaces a month's report in place with a fixture's bytes.
const republish = (
  { idx }: World,
  dataDate: InvestorTypeFixture,
  fixture: InvestorTypeFixture | BrokenInvestorTypeFixture
) => {
  idx.files.set(idxIdUrl(investorTypeItem(dataDate).Prospectus), {
    body: investorTypeFixture(fixture),
    etag: `"etag-${dataDate}:${fixture}"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })
}

// A parse run's record as the admin page reads it.
const runRecord = ({ bucket }: World, kind: string, id: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ParseRunResult))(
    bucket.objects.get(`parse-runs/${kind}/${id}.json`)?.body
  )

interface StockMonth {
  readonly split: boolean
  readonly sharesOutstanding: number
  readonly totalScripless: number
  // `[<5%, ≥5%]` by `<origin>:<type>`, each with a holding.
  readonly holdings: Readonly<Record<string, readonly [number, number]>>
}

// A stock's month of `dataDate` as the stock page reads it; undefined when
// that month's report has no row for it.
const read = ({ holdings }: World, dataDate: string, code: string) =>
  stockPage(StockCode.make(code), undefined).pipe(
    Effect.provide(holdings.layer),
    Effect.map(({ holderSize }): StockMonth | undefined => {
      const month = holderSize.find((each) => each.dataDate === dataDate)
      const holding = month?.holding
      if (month === undefined || holding === undefined) return undefined
      return {
        split: month.split,
        sharesOutstanding: holding.sharesOutstanding,
        totalScripless: holding.totalScripless,
        holdings: Object.fromEntries(
          (["local", "foreign", "combined"] as const).flatMap((origin) =>
            Object.entries(holding[origin] ?? {}).flatMap(
              ([type, { under5, atLeast5 }]) =>
                under5 + atLeast5 === 0
                  ? []
                  : [[`${origin}:${type}`, [under5, atLeast5] as const]]
            )
          )
        ),
      }
    })
  )

const sum = (values: ReadonlyArray<number>) =>
  values.reduce((total, value) => total + value, 0)

describe("an investor-type parse run", () => {
  it.effect("parses every archived investor-type month on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 3,
        parseFailures: [],
      })
      assert.deepStrictEqual(
        runRecord(w, "investor-type", "cron-2026-11-14"),
        result
      )

      // Nov 2025: unsplit, so combined only; every pair of AADI's is written.
      assert.deepStrictEqual(yield* read(w, "2025-11-28", "AADI"), {
        split: false,
        sharesOutstanding: 7_786_891_760,
        totalScripless: 7_786_891_760,
        holdings: {
          "combined:CP": [701_501_094, 4_397_166_772],
          "combined:FD": [4_069_998, 0],
          "combined:IB": [196_305_490, 0],
          "combined:ID": [1_412_471_655, 454_011_607],
          "combined:IS": [81_345_483, 0],
          "combined:MF": [331_782_018, 0],
          "combined:OT": [68_237_987, 0],
          "combined:PF": [73_223_227, 0],
          "combined:SC": [66_776_429, 0],
        },
      })
      // Blank cells hold nothing: TRUE's FD, IS, MF, OT and PF.
      assert.deepStrictEqual((yield* read(w, "2025-11-28", "TRUE"))?.holdings, {
        "combined:CP": [1_903_100, 4_000_000_000],
        "combined:IB": [100, 0],
        "combined:ID": [1_340_985_636, 385_000_000],
        "combined:SC": [2_500_000, 0],
      })
      // WBSA lists from April 2026.
      assert.isUndefined(yield* read(w, "2025-11-28", "WBSA"))

      // Apr 2026: split, TRUE's code a boolean cell, blanks skipped, and
      // combined the sum of local and foreign.
      assert.deepStrictEqual(yield* read(w, "2026-04-30", "TRUE"), {
        split: true,
        sharesOutstanding: 7_571_107_860,
        totalScripless: 6_160_688_792,
        holdings: {
          "local:CP": [10_903_700, 4_401_787_656],
          "local:ID": [1_342_649_536, 385_000_000],
          "foreign:CP": [3_894_400, 0],
          "foreign:IB": [8_055_500, 0],
          "foreign:ID": [1_036_300, 0],
          "foreign:SC": [7_361_700, 0],
          "combined:CP": [14_798_100, 4_401_787_656],
          "combined:IB": [8_055_500, 0],
          "combined:ID": [1_343_685_836, 385_000_000],
          "combined:SC": [7_361_700, 0],
        },
      })

      // Oct 2026: a 0/0 pair holds nothing, as a blank one does.
      const wbsa = yield* read(w, "2026-10-30", "WBSA")
      assert.deepStrictEqual(wbsa?.holdings, {
        "local:CP": [20_197_200, 0],
        "local:ID": [479_851_400, 0],
        "local:SC": [8_623_600, 0],
        "foreign:CP": [758_085_300, 0],
        "foreign:IB": [289_991_100, 0],
        "foreign:ID": [356_000, 0],
        "foreign:MF": [162_066_800, 0],
        "foreign:SC": [80_828_600, 0],
        "combined:CP": [778_282_500, 0],
        "combined:IB": [289_991_100, 0],
        "combined:ID": [480_207_400, 0],
        "combined:MF": [162_066_800, 0],
        "combined:SC": [89_452_200, 0],
      })
      // Every split month's combined rows sum to its total scripless, as its
      // local and foreign rows do.
      for (const code of ["AADI", "BBCA", "TRUE", "WBSA"]) {
        const month = yield* read(w, "2026-10-30", code)
        assert.isDefined(month)
        const of = (origin: string) =>
          sum(
            Object.entries(month.holdings)
              .filter(([key]) => key.startsWith(`${origin}:`))
              .flatMap(([, bands]) => bands)
          )
        assert.strictEqual(of("combined"), month.totalScripless, code)
        assert.strictEqual(
          of("local") + of("foreign"),
          month.totalScripless,
          code
        )
      }
      assert.strictEqual(
        (yield* read(w, "2026-10-30", "BBCA"))?.sharesOutstanding,
        123_275_050_000
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

      republish(w, "2026-10-30", "2026-04-30")
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // October now reads exactly as the republished file: no old row left.
      for (const code of ["AADI", "BBCA", "TRUE", "WBSA"])
        assert.deepStrictEqual(
          yield* read(w, "2026-10-30", code),
          yield* read(w, "2026-04-30", code)
        )
    })
  )

  it.effect("parses every month again when the parser's version changes", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")
      w.holdings.database
        .prepare(
          "UPDATE investor_type_month SET parser_version = parser_version - 1"
        )
        .run()
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 3 })
    })
  )

  it.effect("fails when it can't read which months were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM investor_type_month"))
      const failure = yield* Effect.flip(parse(w, "cron-2026-11-14"))
      assert.strictEqual(failure._tag, "StepFailed")
      assert.deepInclude(runRecord(w, "investor-type", "cron-2026-11-14"), {
        outcome: "failed",
        error: failure.message,
        monthsParsed: 0,
      })
    })
  )
})

describe("an investor-type report that doesn't match what's expected", () => {
  const cases: ReadonlyArray<{
    readonly what: string
    readonly month: InvestorTypeFixture
    readonly fixture: BrokenInvestorTypeFixture
    readonly reason: string
  }> = [
    {
      what: "a header that matches neither layout",
      month: "2026-10-30",
      fixture: "unknown-header",
      reason: "Header row 2's AN isn't TOTAL SCRIPLESS: TOTAL SHARES",
    },
    {
      what: "a row whose types don't sum to its total",
      month: "2026-04-30",
      fixture: "unsummed",
      reason:
        "BBCA (row 6)'s types sum to 52,453,691,121, not its TOTAL SCRIPLESS of 52,453,691,120",
    },
    {
      what: "a stock code listed twice",
      month: "2025-11-28",
      fixture: "duplicate-code",
      reason: "Row 5 lists AADI again, after row 4",
    },
    {
      what: "no stock rows",
      month: "2026-10-30",
      fixture: "empty",
      reason: "The report has no stocks",
    },
  ]

  for (const { what, month, fixture, reason } of cases)
    it.effect(
      `fails its month with ${what}, keeps the month's rows, and tries it again next run`,
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archive(w, "cron-2026-11-14T06")
          yield* parse(w, "cron-2026-11-14")
          const before = yield* read(w, month, "AADI")
          assert.isDefined(before)

          republish(w, month, fixture)
          yield* archive(w, "cron-2026-11-14T13")
          const failed = yield* parse(w, "cron-2026-11-15")
          assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(failed.parseFailures, [
            { date: month, message: reason },
          ])
          assert.deepStrictEqual(
            runRecord(w, "investor-type", "cron-2026-11-15"),
            failed
          )
          assert.deepStrictEqual(yield* read(w, month, "AADI"), before)

          const retried = yield* parse(w, "cron-2026-11-16")
          assert.deepInclude(retried, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(retried.parseFailures, failed.parseFailures)
        })
    )

  it.effect("leaves a month it never parsed absent", () =>
    Effect.gen(function* () {
      const w = world()
      republish(w, "2026-04-30", "unsummed")
      yield* archive(w, "cron-2026-11-14T06")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, { outcome: "partial", monthsParsed: 2 })
      assert.isUndefined(yield* read(w, "2026-04-30", "AADI"))
      assert.isDefined(yield* read(w, "2026-10-30", "AADI"))
    })
  )
})

describe("the two parse run kinds", () => {
  const parseClassification = runParse(classificationParseRuns)

  // IDX replaces a classification month's report in place with a broken copy.
  const breakClassification = (
    { idx }: World,
    dataDate: ClassificationFixture
  ) =>
    idx.files.set(idxIdUrl(classificationItem(dataDate).Prospectus), {
      body: classificationFixture("unsummed"),
      etag: `"etag-${dataDate}:unsummed"`,
      lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
    })

  it.effect(
    "each parse only their own kind's months, into their own records",
    () =>
      Effect.gen(function* () {
        const w = world(true)
        breakClassification(w, "2026-10-30")
        republish(w, "2025-11-28", "empty")
        yield* archive(w, "cron-2026-11-14T13")

        const investorType = yield* parse(w, "cron-2026-11-14")
        assert.deepInclude(investorType, {
          outcome: "partial",
          monthsParsed: 2,
        })
        assert.deepStrictEqual(
          investorType.parseFailures.map(({ date }) => date),
          ["2025-11-28"]
        )
        const classification = yield* parseClassification(w, "cron-2026-11-14")
        assert.deepInclude(classification, {
          outcome: "partial",
          monthsParsed: 1,
        })
        assert.deepStrictEqual(
          classification.parseFailures.map(({ date }) => date),
          ["2026-10-30"]
        )

        assert.deepStrictEqual(
          runRecord(w, "investor-type", "cron-2026-11-14"),
          investorType
        )
        assert.deepStrictEqual(
          runRecord(w, "investor-classification", "cron-2026-11-14"),
          classification
        )
        // October's classification failure left its investor-type month
        // parsed.
        assert.isDefined(yield* read(w, "2026-10-30", "BBCA"))
      })
  )
})
