// The Classification parse run: the shareholding archive's classification
// reports parsed into parsed holdings, read back as the stock page reads a
// stock's month.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { stockPage } from "@/server/holdings/stock-page"
import { archiveRun } from "@/server/shareholding/archive-run"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"

import {
  type BrokenFixture,
  classificationFixture,
  classificationIdx,
  classificationItem,
  type ClassificationFixture,
  type FakeIdx,
  idxIdUrl,
  type InlineFixture,
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

const world = (): World => ({
  idx: classificationIdx(),
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

const parse = ({ bucket, holdings }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      classificationParseRuns.run(
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

// IDX replaces a month's report in place with a fixture's bytes.
const republish = (
  { idx }: World,
  dataDate: ClassificationFixture,
  fixture: ClassificationFixture | BrokenFixture | InlineFixture
) => {
  const url = idxIdUrl(classificationItem(dataDate).Prospectus)
  idx.files.set(url, {
    body: classificationFixture(fixture),
    etag: `"etag-${dataDate}:${fixture}"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })
}

// IDX replaces October's report in place with September's bytes.
const republishOctober = (w: World) => republish(w, "2026-10-30", "2026-09-30")

// A parse run's record as the admin page reads it.
const runRecord = ({ bucket }: World, id: string) =>
  Schema.decodeUnknownSync(ParseRunResult)(
    storedRun(
      archiveDbOf(bucket),
      shareholdingParse("investor-classification"),
      id
    )
  )

const page = ({ holdings }: World, code: string, month?: string) =>
  stockPage(StockCode.make(code), month).pipe(Effect.provide(holdings.layer))

// The stock's month of `dataDate` on its stock page; undefined when that
// month's report has no row for it.
const read = (w: World, dataDate: string, code: string) =>
  Effect.map(page(w, code, dataDate.slice(0, 7)), ({ composition }) =>
    composition?.month.dataDate === dataDate ? composition.month : undefined
  )

// A stock-month's non-zero shares by `<origin>:<classification>`.
const sharesOf = (month: Effect.Success<ReturnType<typeof read>>) =>
  Object.fromEntries(
    (month?.types ?? []).flatMap(({ classifications }) =>
      classifications.flatMap((held) =>
        (["combined", "local", "foreign"] as const).flatMap((origin) => {
          const shares = held[origin] ?? 0
          return shares > 0
            ? [[`${origin}:${held.classification}`, shares]]
            : []
        })
      )
    )
  )

describe("a classification parse run", () => {
  it.effect("parses every archived classification month on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 4,
        parseFailures: [],
      })
      assert.deepStrictEqual(runRecord(w, "cron-2026-11-14"), result)

      // Sep 2026+: split into local and foreign, with their combined sum.
      const october = yield* read(w, "2026-10-30", "BBCA")
      assert.strictEqual(october?.totalScripless, 52_453_691_120)
      assert.strictEqual(
        (yield* page(w, "BBCA")).issuerName,
        "BANK CENTRAL ASIA Tbk"
      )
      const oct = sharesOf(october)
      assert.strictEqual(oct["local:bank"], 513_627_500)
      assert.strictEqual(oct["foreign:bank"], 1_001_934_435)
      assert.strictEqual(oct["combined:bank"], 1_515_561_935)
      assert.strictEqual(oct["foreign:mutual_funds"], 18_426_305_724)
      assert.strictEqual(oct["local:individual"], 12_256_650_330)
      // Zeros are skipped: BBCA's local trustee bank is 0.
      assert.notProperty(oct, "local:trustee_bank")
      assert.strictEqual(oct["combined:trustee_bank"], 1_004_462_498)

      // Mar–Aug: combined only, and May's empty trailing column is ignored.
      const may = sharesOf(yield* read(w, "2026-05-29", "BBCA"))
      assert.strictEqual(may["combined:bank"], 1_727_535_968)
      assert.strictEqual(may["combined:individual"], 10_923_855_564)
      assert.strictEqual(Object.keys(may).length, 36)
      assert.isTrue(
        Object.keys(may).every((key) => key.startsWith("combined:"))
      )
      assert.deepStrictEqual(sharesOf(yield* read(w, "2026-05-29", "ACRO")), {
        "combined:investment_advisors": 8_449_100,
        "combined:cv_limited_partnership": 4_700,
        "combined:corporate": 15_000,
        "combined:securities_company": 105_403,
        "combined:individual": 3_460_771_334,
      })

      // WBSA isn't in March's report.
      assert.isUndefined(yield* read(w, "2026-03-31", "WBSA"))
      assert.strictEqual(
        (yield* read(w, "2026-05-29", "WBSA"))?.totalScripless,
        1_800_000_000
      )
      assert.strictEqual(
        (yield* page(w, "WBSA")).issuerName,
        "BSA LOGISTICS INDONESIA Tbk"
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
      const september = yield* read(w, "2026-09-30", "BBCA")
      assert.notDeepEqual(yield* read(w, "2026-10-30", "BBCA"), september)

      republishOctober(w)
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // October now reads exactly as the republished file: no old row left.
      assert.deepStrictEqual(
        sharesOf(yield* read(w, "2026-10-30", "BBCA")),
        sharesOf(september)
      )
      assert.deepStrictEqual(
        sharesOf(yield* read(w, "2026-10-30", "WBSA")),
        sharesOf(yield* read(w, "2026-09-30", "WBSA"))
      )
    })
  )

  it.effect("reads a SHARE_CODE written as an inline string", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")
      const october = yield* read(w, "2026-10-30", "BBCA")

      republish(w, "2026-10-30", "inline-code")
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      assert.deepStrictEqual(yield* read(w, "2026-10-30", "BBCA"), october)
    })
  )

  it.effect(
    "keeps a month whole when its replace fails, and parses it next run",
    () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, "cron-2026-11-14")
        const october = yield* read(w, "2026-10-30", "BBCA")

        republishOctober(w)
        yield* archive(w, "cron-2026-11-14T13")
        // Every attempt fails after deleting and inserting: each rolls back.
        w.holdings.failBatch = (sql) =>
          sql.some((statement) =>
            statement.startsWith("DELETE FROM classification_holding")
          )
        const failed = yield* parse(w, "cron-2026-11-15")
        assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
        assert.deepStrictEqual(
          failed.parseFailures.map(({ date }) => date),
          ["2026-10-30"]
        )
        assert.deepStrictEqual(yield* read(w, "2026-10-30", "BBCA"), october)

        w.holdings.failBatch = undefined
        const retried = yield* parse(w, "cron-2026-11-16")
        assert.deepInclude(retried, {
          outcome: "complete",
          monthsParsed: 1,
          parseFailures: [],
        })
        assert.deepStrictEqual(
          sharesOf(yield* read(w, "2026-10-30", "BBCA")),
          sharesOf(yield* read(w, "2026-09-30", "BBCA"))
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
          "UPDATE classification_month SET parser_version = parser_version - 1"
        )
        .run()
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 4 })
    })
  )

  it.effect("fails when it can't read which months were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM classification_month"))
      const failure = yield* Effect.flip(parse(w, "cron-2026-11-14"))
      assert.strictEqual(failure._tag, "StepFailed")
      const record = runRecord(w, "cron-2026-11-14")
      assert.deepInclude(record, {
        outcome: "failed",
        error: failure.message,
        monthsParsed: 0,
        parseFailures: [],
      })
      assert.isNotNull(record.finishedAt)
    })
  )
})

describe("a classification report that doesn't match what's expected", () => {
  const cases: ReadonlyArray<{
    readonly what: string
    readonly fixture: BrokenFixture
    readonly reason: string
  }> = [
    {
      what: "a header that matches neither layout",
      fixture: "unknown-header",
      reason: "Header row 4 has no TOTAL SCRIPLESS",
    },
    {
      what: "a classification column twice",
      fixture: "repeated-column",
      reason: "Header row 4 names Local_Bank twice",
    },
    {
      what: "a classification outside the 39",
      fixture: "unknown-classification",
      reason: "Header row 6 names an unknown classification: BANKS",
    },
    {
      what: "a row whose classifications don't sum to its total",
      fixture: "unsummed",
      reason:
        "BBCA (row 9)'s classifications sum to 52,453,691,121, not its TOTAL SCRIPLESS of 52,453,691,120",
    },
    {
      what: "no stock rows",
      fixture: "empty",
      reason: "The report has no stocks",
    },
    {
      what: "an error cell",
      fixture: "error-code",
      reason: "Cell B7 holds the error #N/A",
    },
    {
      what: "a stock row whose SHARE_CODE is a number",
      fixture: "numeric-code",
      reason: "Row 7's SHARE CODE isn't text: 277",
    },
    {
      what: "a stock row with no SHARE_CODE",
      fixture: "no-code",
      reason: "Row 7 has no SHARE CODE",
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
          const october = yield* read(w, "2026-10-30", "BBCA")

          republish(w, "2026-10-30", fixture)
          yield* archive(w, "cron-2026-11-14T13")
          const failed = yield* parse(w, "cron-2026-11-15")
          assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(failed.parseFailures, [
            { date: "2026-10-30", message: reason },
          ])
          assert.deepStrictEqual(runRecord(w, "cron-2026-11-15"), failed)
          assert.deepStrictEqual(yield* read(w, "2026-10-30", "BBCA"), october)

          const retried = yield* parse(w, "cron-2026-11-16")
          assert.deepInclude(retried, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(retried.parseFailures, failed.parseFailures)
        })
    )

  it.effect("leaves a month it never parsed absent", () =>
    Effect.gen(function* () {
      const w = world()
      republish(w, "2026-05-29", "unsummed")
      yield* archive(w, "cron-2026-11-14T06")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, { outcome: "partial", monthsParsed: 3 })
      assert.deepStrictEqual(
        result.parseFailures.map(({ date }) => date),
        ["2026-05-29"]
      )
      assert.isUndefined(yield* read(w, "2026-05-29", "BBCA"))
      assert.isDefined(yield* read(w, "2026-03-31", "BBCA"))
    })
  )
})
