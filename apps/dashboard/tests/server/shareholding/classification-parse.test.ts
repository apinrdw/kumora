// The archive run's reconcile: classification reports parsed into parsed
// holdings, read back as the stock page reads a stock's month.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { classificationStockMonth } from "@/server/holdings/classification"
import { RunId } from "@/server/archive/run"
import { archiveRun } from "@/server/shareholding/archive-run"

import {
  classificationFixture,
  classificationIdx,
  classificationItem,
  type FakeIdx,
  idxIdUrl,
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

const world = (): World => ({
  idx: classificationIdx(),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const run = ({ idx, bucket, holdings }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      archiveRun(
        localSteps(Layer.mergeAll(idx.layer, bucket.layer, holdings.layer)),
        {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T13:00:00Z"),
        }
      )
    )
  )

// IDX replaces October's report in place with September's bytes.
const republishOctober = ({ idx }: World) => {
  const url = idxIdUrl(classificationItem("2026-10-30").Prospectus)
  idx.files.set(url, {
    body: classificationFixture("2026-09-30"),
    etag: `"etag-october:1"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })
}

const read = ({ holdings }: World, dataDate: string, code: string) =>
  classificationStockMonth(dataDate, code).pipe(Effect.provide(holdings.layer))

// A stock-month's shares by `<origin>:<classification>`.
const sharesOf = (
  month: Effect.Success<ReturnType<typeof classificationStockMonth>>
) =>
  Object.fromEntries(
    (month?.holdings ?? []).map(({ origin, classification, shares }) => [
      `${origin}:${classification}`,
      shares,
    ])
  )

describe("an archive run's reconcile", () => {
  it.effect(
    "parses every archived classification month on a fresh database",
    () =>
      Effect.gen(function* () {
        const w = world()
        const result = yield* run(w, "cron-2026-11-14T13")
        assert.deepInclude(result, { outcome: "complete", monthsParsed: 4 })

        // Sep 2026+: split into local and foreign, with their combined sum.
        const october = yield* read(w, "2026-10-30", "BBCA")
        assert.deepInclude(october, {
          issuerName: "BANK CENTRAL ASIA Tbk",
          totalScripless: 52_453_691_120,
        })
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
        assert.deepInclude(yield* read(w, "2026-05-29", "WBSA"), {
          issuerName: "BSA LOGISTICS INDONESIA Tbk",
          totalScripless: 1_800_000_000,
        })
      })
  )

  it.effect("parses nothing when nothing changed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* run(w, "cron-2026-11-14T06")
      const result = yield* run(w, "cron-2026-11-14T13")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 0 })
    })
  )

  it.effect("replaces a month with its republished version", () =>
    Effect.gen(function* () {
      const w = world()
      yield* run(w, "cron-2026-11-14T06")
      const september = yield* read(w, "2026-09-30", "BBCA")
      assert.notDeepEqual(yield* read(w, "2026-10-30", "BBCA"), september)

      republishOctober(w)
      const result = yield* run(w, "cron-2026-11-14T13")
      assert.deepInclude(result, { newVersions: 1, monthsParsed: 1 })
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

  it.effect(
    "keeps a month whole when its replace fails, and parses it next run",
    () =>
      Effect.gen(function* () {
        const w = world()
        yield* run(w, "cron-2026-11-14T06")
        const october = yield* read(w, "2026-10-30", "BBCA")

        republishOctober(w)
        // Every attempt fails after deleting and inserting: each rolls back.
        w.holdings.failBatch = (sql) =>
          sql.some((statement) =>
            statement.startsWith("DELETE FROM classification_holding")
          )
        const failed = yield* run(w, "cron-2026-11-14T13")
        assert.deepInclude(failed, { newVersions: 1, monthsParsed: 0 })
        assert.deepStrictEqual(yield* read(w, "2026-10-30", "BBCA"), october)

        w.holdings.failBatch = undefined
        const retried = yield* run(w, "cron-2026-11-14T20")
        assert.deepInclude(retried, { newVersions: 0, monthsParsed: 1 })
        assert.deepStrictEqual(
          sharesOf(yield* read(w, "2026-10-30", "BBCA")),
          sharesOf(yield* read(w, "2026-09-30", "BBCA"))
        )
      })
  )

  it.effect("parses a month again when an older parser parsed it", () =>
    Effect.gen(function* () {
      const w = world()
      yield* run(w, "cron-2026-11-14T06")
      w.holdings.database
        .prepare(
          "UPDATE classification_month SET parser_version = parser_version - 1 WHERE data_date = '2026-05-29'"
        )
        .run()
      const result = yield* run(w, "cron-2026-11-14T13")
      assert.deepInclude(result, { monthsParsed: 1 })
    })
  )
})
