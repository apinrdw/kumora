// The KSEI parse run: the KSEI archive's Securities holdings reports parsed
// into parsed holdings, read back as the stock page reads a stock's series.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { KSEI_TYPES } from "@/domain/holdings"
import { stockPage } from "@/server/holdings/stock-page"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { kseiParseRuns } from "@/server/ksei/parse-runs"

import { localSteps } from "../archive/local-steps.ts"
import { memoryArchiveDb } from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  type MemoryHoldingsDb,
  memoryHoldingsDb,
} from "../holdings/memory-holdings-db.ts"
import {
  type BrokenHoldingsFixture,
  type FakeKsei,
  fileOf,
  holdingsFixture,
  holdingsKsei,
  holdingsUrl,
} from "./fake-ksei.ts"

interface World {
  readonly ksei: FakeKsei
  readonly bucket: MemoryBucket
  readonly holdings: MemoryHoldingsDb
}

const world = (): World => ({
  ksei: holdingsKsei(),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const archive = ({ ksei, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiArchiveRun(
        localSteps(
          Layer.mergeAll(ksei.layer, bucket.layer, memoryArchiveDb().layer)
        ),
        {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T03:00:00Z"),
        }
      )
    )
  )

const parse = ({ bucket, holdings }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiParseRuns.run(localSteps(Layer.merge(bucket.layer, holdings.layer)), {
        id: RunId.make(id),
        trigger: "cron",
        startedAt: new Date("2026-11-14T04:00:00Z"),
      })
    )
  )

// KSEI replaces October's report in place with `body`.
const republishOctober = ({ ksei }: World, body: Uint8Array<ArrayBuffer>) => {
  ksei.files.set(holdingsUrl("BalanceposEfek20261030.zip"), fileOf(body))
}

// The stock's holdings in the report of `periodEnd`, from its stock page's
// series; undefined when that report has no EQUITY row for it.
const read = ({ holdings }: World, periodEnd: string, code: string) =>
  stockPage(StockCode.make(code), undefined).pipe(
    Effect.provide(holdings.layer),
    Effect.map(
      ({ series }) =>
        series.find((month) => month.holdings?.periodEnd === periodEnd)
          ?.holdings
    )
  )

// A stock-month's non-zero shares by `<origin>:<KSEI investor type>`.
const sharesOf = (month: Effect.Success<ReturnType<typeof read>>) =>
  Object.fromEntries(
    month === undefined
      ? []
      : (["local", "foreign"] as const).flatMap((origin) =>
          KSEI_TYPES.flatMap((type) =>
            month[origin][type] > 0
              ? [[`${origin}:${type}`, month[origin][type]]]
              : []
          )
        )
  )

// Its scripless shares: every origin's types, which each origin's Total
// matched.
const scripless = (month: Effect.Success<ReturnType<typeof read>>) =>
  Object.values(sharesOf(month)).reduce((sum, shares) => sum + shares, 0)

describe("a KSEI parse run", () => {
  it.effect("parses every held month on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 4,
        parseFailures: [],
      })

      const october = yield* read(w, "2026-10-30", "BBCA")
      assert.strictEqual(scripless(october), 52_453_691_120)
      const oct = sharesOf(october)
      assert.strictEqual(oct["local:ID"], 12_030_567_470)
      assert.strictEqual(oct["local:IS"], 2_310_613_490)
      assert.strictEqual(oct["foreign:MF"], 20_393_323_810)
      assert.strictEqual(oct["foreign:OT"], 5_420_869_622)
      assert.strictEqual(Object.keys(oct).length, 18)

      // Zeros are skipped: ACRO holds nothing local but CP, ID and SC.
      assert.deepStrictEqual(sharesOf(yield* read(w, "2026-10-30", "ACRO")), {
        "local:CP": 4700,
        "local:ID": 3_361_481_534,
        "local:SC": 103,
        "foreign:ID": 107_747_300,
        "foreign:SC": 111_900,
      })

      // An unpriced equity is kept.
      assert.strictEqual(
        scripless(yield* read(w, "2026-05-29", "APOL")),
        6_869_778_660
      )

      // Only EQUITY rows: no bond, no warrant.
      assert.isUndefined(yield* read(w, "2026-10-30", "FR0042"))
      assert.isUndefined(yield* read(w, "2026-10-30", "BRNA-W"))
      // No report for July.
      assert.isUndefined(yield* read(w, "2026-07-31", "BBCA"))
    })
  )

  it.effect("parses nothing when nothing changed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 0 })
    })
  )

  it.effect("replaces a month with its republished version", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14")
      const september = yield* read(w, "2026-09-30", "BBCA")
      assert.notDeepEqual(
        sharesOf(yield* read(w, "2026-10-30", "BBCA")),
        sharesOf(september)
      )

      republishOctober(w, holdingsFixture("BalanceposEfek20260930.zip"))
      yield* archive(w, "cron-2026-11-15")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // October now reads exactly as the republished report: no old row left.
      assert.deepStrictEqual(
        sharesOf(yield* read(w, "2026-10-30", "BBCA")),
        sharesOf(september)
      )
      assert.deepStrictEqual(
        sharesOf(yield* read(w, "2026-10-30", "ACRO")),
        sharesOf(yield* read(w, "2026-09-30", "ACRO"))
      )
    })
  )

  const BROKEN: ReadonlyArray<[BrokenHoldingsFixture, string]> = [
    ["BalanceposEfek20261030-header.zip", "header"],
    ["BalanceposEfek20261030-sum.zip", "BBCA"],
    ["BalanceposEfek20261030-no-equity.zip", "no EQUITY"],
    ["BalanceposEfek20261030-no-code.zip", "Line 5 has no Code"],
  ]
  for (const [broken, reason] of BROKEN)
    it.effect(
      `fails only the month of ${broken}, keeps its rows, and ends partial`,
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archive(w, "cron-2026-11-14")
          yield* parse(w, "cron-2026-11-14")
          const october = yield* read(w, "2026-10-30", "BBCA")

          republishOctober(w, holdingsFixture(broken))
          yield* archive(w, "cron-2026-11-15")
          // A parser version bump re-parses every month, the broken one too.
          w.holdings.database
            .prepare(
              "UPDATE ksei_month SET parser_version = parser_version - 1"
            )
            .run()
          const result = yield* parse(w, "cron-2026-11-15")
          assert.deepInclude(result, { outcome: "partial", monthsParsed: 3 })
          assert.lengthOf(result.parseFailures, 1)
          assert.strictEqual(result.parseFailures[0]?.date, "2026-10-30")
          assert.include(result.parseFailures[0]?.message, reason)
          assert.deepStrictEqual(yield* read(w, "2026-10-30", "BBCA"), october)

          // The next run tries the month again.
          const again = yield* parse(w, "cron-2026-11-16")
          assert.deepInclude(again, { outcome: "partial", monthsParsed: 0 })
          assert.lengthOf(again.parseFailures, 1)
        })
    )

  it.effect("parses a month again when an older parser parsed it", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14")
      w.holdings.database
        .prepare(
          "UPDATE ksei_month SET parser_version = parser_version - 1 WHERE period_end = '2026-08-31'"
        )
        .run()
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
    })
  )

  it.effect("fails when it can't read which months were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM ksei_month"))
      const error = yield* Effect.flip(parse(w, "cron-2026-11-14"))
      assert.strictEqual(error._tag, "StepFailed")
      const record = JSON.parse(
        w.bucket.objects.get("parse-runs/cron-2026-11-14.json")?.body ?? "null"
      )
      assert.deepInclude(record, { outcome: "failed", monthsParsed: 0 })
      assert.isNotNull(record.finishedAt)
    })
  )
})
