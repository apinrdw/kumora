// The KSEI parse run's parse coverage: each archived Securities holdings
// month's state, from the KSEI archive, the parsed holdings and the last
// finished KSEI parse run.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { readAlone } from "@/server/archive/page-read"
import { type RunBase, RunId } from "@/server/archive/run"
import { KSEI_PARSER_VERSION } from "@/server/holdings/ksei"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { kseiParseRuns } from "@/server/ksei/parse-runs"

import { localSteps } from "../archive/local-steps.ts"
import type { MemoryArchiveDb } from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import { archiveDbOf, KSEI_PARSE, seedRun } from "../archive/runs.ts"
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
  readonly index: MemoryArchiveDb
}

const world = (): World => {
  const bucket = memoryBucket()
  return {
    ksei: holdingsKsei(),
    bucket,
    holdings: memoryHoldingsDb(),
    // One ArchiveDb holds both the report index and the runs.
    index: archiveDbOf(bucket),
  }
}

// Today, so the grid ends in 2026.
const start = TestClock.setTime(Date.parse("2026-11-17T03:00:00Z"))

const archive = ({ ksei, bucket, index }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiArchiveRun(
        localSteps(Layer.mergeAll(ksei.layer, bucket.layer, index.layer)),
        {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T03:00:00Z"),
        }
      )
    )
  )

const parse = ({ bucket, holdings }: World, id: string, startedAt: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiParseRuns.run(
        localSteps(
          Layer.mergeAll(
            bucket.layer,
            holdings.layer,
            archiveDbOf(bucket).layer
          )
        ),
        {
          id: RunId.make(id),
          trigger: id.startsWith("admin") ? "admin" : "cron",
          startedAt: new Date(startedAt),
        }
      )
    )
  )

const breakOctober = ({ ksei }: World, broken: BrokenHoldingsFixture) => {
  ksei.files.set(
    holdingsUrl("BalanceposEfek20261030.zip"),
    fileOf(holdingsFixture(broken))
  )
}

const bumpParser = ({ holdings }: World, periodEnd: string) => {
  holdings.database
    .prepare(
      "UPDATE ksei_month SET parser_version = parser_version - 1 WHERE period_end = ?"
    )
    .run(periodEnd)
}

// The parse coverage as each year's twelve cells, a cell its state or "" when
// blank.
const coverage = ({ bucket, holdings, index }: World) =>
  readAlone(kseiParseRuns.parseCoverage).pipe(
    Effect.provide(Layer.mergeAll(bucket.layer, holdings.layer, index.layer))
  )

const parseCoverage = (w: World) =>
  coverage(w).pipe(
    Effect.map((years) =>
      Object.fromEntries(
        years.map(({ year, months }) => [
          year,
          months.map((month): string => month?.state ?? ""),
        ])
      )
    )
  )

// 2026's cell for the month at `index`, January being 0.
const cell = (w: World, index: number) =>
  coverage(w).pipe(
    Effect.map(
      (years) => years.find(({ year }) => year === 2026)?.months[index]
    )
  )

// 2026's cells for May, then August to October; every other month is blank.
const may2026 = (
  may: string,
  august: string,
  september: string,
  october: string
) => ({
  2026: ["", "", "", "", may, "", "", august, september, october, "", ""],
})

describe("the KSEI parse coverage", () => {
  it.effect("shows nothing before any month is archived", () =>
    Effect.gen(function* () {
      yield* start
      assert.deepStrictEqual(yield* parseCoverage(world()), {})
    })
  )

  it.effect(
    "shows each archived month not parsed yet, and the rest blank",
    () =>
      Effect.gen(function* () {
        yield* start
        const w = world()
        yield* archive(w, "cron-2026-11-14")
        assert.deepStrictEqual(
          yield* parseCoverage(w),
          may2026("not-parsed", "not-parsed", "not-parsed", "not-parsed")
        )
      })
  )

  it.effect("shows each month parsed once a parse run parsed it", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "parsed", "parsed", "parsed")
      )
    })
  )

  it.effect("shows a month stale once a newer version is archived", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      w.ksei.files.set(
        holdingsUrl("BalanceposEfek20261030.zip"),
        fileOf(holdingsFixture("BalanceposEfek20260930.zip"))
      )
      yield* archive(w, "cron-2026-11-15")
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "parsed", "parsed", "stale")
      )
    })
  )

  it.effect("shows a month stale when an older parser parsed it", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      bumpParser(w, "2026-08-31")
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "stale", "parsed", "parsed")
      )
    })
  )

  it.effect("shows a month failed though it keeps older parsed holdings", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      breakOctober(w, "BalanceposEfek20261030-header.zip")
      yield* archive(w, "cron-2026-11-15")
      yield* parse(w, "cron-2026-11-15", "2026-11-15T04:00:00Z")
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "parsed", "parsed", "failed")
      )
    })
  )

  it.effect("shows a month failed that has no parsed holdings", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      breakOctober(w, "BalanceposEfek20261030-sum.zip")
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "parsed", "parsed", "failed")
      )
    })
  )

  it.effect(
    "takes failures from the last finished run, not one in progress",
    () =>
      Effect.gen(function* () {
        yield* start
        const w = world()
        breakOctober(w, "BalanceposEfek20261030-sum.zip")
        yield* archive(w, "cron-2026-11-14")
        yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
        // An admin run started later is still running: its record has no
        // failures yet.
        seedRun(archiveDbOf(w.bucket), KSEI_PARSE, {
          id: RunId.make("admin-1763434800000"),
          trigger: "admin",
          startedAt: "2026-11-15T03:00:00.000Z",
          finishedAt: null,
          outcome: "running",
          monthsParsed: 0,
          parseFailures: [],
          error: null,
        } as RunBase)
        assert.deepStrictEqual(
          yield* parseCoverage(w),
          may2026("parsed", "parsed", "parsed", "failed")
        )

        // A later finished run of the other trigger parsed the fixed month.
        w.ksei.files.set(
          holdingsUrl("BalanceposEfek20261030.zip"),
          fileOf(holdingsFixture("BalanceposEfek20261030.zip"))
        )
        yield* archive(w, "cron-2026-11-16")
        yield* parse(w, "admin-1763521200000", "2026-11-16T03:00:00Z")
        assert.deepStrictEqual(
          yield* parseCoverage(w),
          may2026("parsed", "parsed", "parsed", "parsed")
        )
      })
  )

  it.effect(
    "details a parsed month's versions, parse time and stock count",
    () =>
      Effect.gen(function* () {
        yield* start
        const w = world()
        yield* archive(w, "cron-2026-11-14")
        yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
        const october = yield* cell(w, 9)
        assert.strictEqual(october?.state, "parsed")
        assert.strictEqual(october?.date, "2026-10-30")
        assert.match(october?.newestSha256 ?? "", /^[0-9a-f]{64}$/)
        assert.deepStrictEqual(october?.parsed, {
          sha256: october?.newestSha256 ?? "",
          parserVersion: KSEI_PARSER_VERSION,
          parsedAt: "2026-11-17T05:00:00.000Z",
          // Its report's five equities; the bond and the warrant aren't
          // parsed.
          stockCount: 5,
        })
      })
  )

  it.effect("says why a month is stale", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      const parsedOctober = (yield* cell(w, 9))?.newestSha256
      w.ksei.files.set(
        holdingsUrl("BalanceposEfek20261030.zip"),
        fileOf(holdingsFixture("BalanceposEfek20260930.zip"))
      )
      yield* archive(w, "cron-2026-11-15")
      bumpParser(w, "2026-08-31")
      bumpParser(w, "2026-10-30")

      const october = yield* cell(w, 9)
      assert.strictEqual(october?.state, "stale")
      assert.notStrictEqual(october?.newestSha256, parsedOctober)
      assert.strictEqual(october?.parsed?.sha256, parsedOctober)
      assert.deepStrictEqual(october?.staleCauses, [
        "newer-version",
        "parser-updated",
      ])
      const august = yield* cell(w, 7)
      assert.strictEqual(august?.state, "stale")
      assert.deepStrictEqual(august?.staleCauses, ["parser-updated"])
      assert.strictEqual(august?.parsed?.parserVersion, KSEI_PARSER_VERSION - 1)
      assert.deepStrictEqual((yield* cell(w, 4))?.staleCauses, [])
    })
  )

  it.effect(
    "gives a failed month's message and run, and its older parsed version",
    () =>
      Effect.gen(function* () {
        yield* start
        const w = world()
        yield* archive(w, "cron-2026-11-14")
        yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
        const parsedOctober = (yield* cell(w, 9))?.newestSha256
        breakOctober(w, "BalanceposEfek20261030-header.zip")
        yield* archive(w, "cron-2026-11-15")
        yield* parse(w, "admin-1763434800000", "2026-11-15T04:00:00Z")

        const october = yield* cell(w, 9)
        assert.strictEqual(october?.state, "failed")
        assert.strictEqual(october?.failure?.run, "admin-1763434800000")
        assert.include(october?.failure?.message, "header")
        assert.strictEqual(october?.parsed?.sha256, parsedOctober)
        assert.strictEqual(october?.parsed?.stockCount, 5)
        assert.isNull((yield* cell(w, 8))?.failure)
      })
  )

  it.effect("gives a failed month with no parsed holdings none", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      breakOctober(w, "BalanceposEfek20261030-sum.zip")
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      const october = yield* cell(w, 9)
      assert.strictEqual(october?.state, "failed")
      assert.strictEqual(october?.failure?.run, "cron-2026-11-14")
      assert.isNull(october?.parsed)
    })
  )

  it.effect("shows a month's later date when two share its month", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      // A report dated 2026-10-31, never parsed, indexed by the next run.
      w.bucket.objects.set(
        `reports/securities-holdings/2026-10-31/${"a".repeat(64)}.zip`,
        { body: "zip", contentType: "application/zip", customMetadata: {} }
      )
      w.bucket.objects.set(
        `reports/securities-holdings/2026-10-31/${"a".repeat(64)}.2026-11-17T050000.000Z.0123456789abcdef.json`,
        { body: "{}", contentType: "application/json", customMetadata: {} }
      )
      yield* archive(w, "cron-2026-11-15")
      const years = yield* coverage(w)
      assert.strictEqual(years[0]?.months[9]?.date, "2026-10-31")
      assert.strictEqual(years[0]?.months[9]?.state, "not-parsed")
    })
  )

  it.effect("takes each month's newest version from the report index", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      w.ksei.files.set(
        holdingsUrl("BalanceposEfek20261030.zip"),
        fileOf(holdingsFixture("BalanceposEfek20260930.zip"))
      )
      yield* archive(w, "cron-2026-11-15")
      // The index alone holds what was archived: the bucket's reports are
      // gone.
      for (const key of w.bucket.objects.keys())
        if (key.startsWith("reports/")) w.bucket.objects.delete(key)
      assert.deepStrictEqual(
        yield* parseCoverage(w),
        may2026("parsed", "parsed", "parsed", "stale")
      )
    })
  )

  it.effect(
    "takes the version a parse run reads when two were fetched at once",
    () =>
      Effect.gen(function* () {
        yield* start
        const w = world()
        yield* archive(w, "cron-2026-11-14")
        w.ksei.files.set(
          holdingsUrl("BalanceposEfek20261030.zip"),
          fileOf(holdingsFixture("BalanceposEfek20260930.zip"))
        )
        // A second run at the same instant: October's two versions share
        // their fetched-at.
        yield* kseiArchiveRun(
          localSteps(
            Layer.mergeAll(w.ksei.layer, w.bucket.layer, w.index.layer)
          ),
          {
            id: RunId.make("admin-2026-11-14"),
            trigger: "admin",
            startedAt: new Date("2026-11-14T03:00:00Z"),
          }
        )
        const fetchedAts = w.index.database
          .prepare(
            "SELECT DISTINCT fetched_at FROM archived_report " +
              "WHERE report_date = '2026-10-30' AND kind = 'securities-holdings'"
          )
          .all()
        assert.strictEqual(fetchedAts.length, 1)
        assert.strictEqual(
          w.index.database
            .prepare(
              "SELECT COUNT(*) AS count FROM archived_report " +
                "WHERE report_date = '2026-10-30' AND kind = 'securities-holdings'"
            )
            .get()?.count,
          2
        )

        yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
        assert.deepStrictEqual(
          yield* parseCoverage(w),
          may2026("parsed", "parsed", "parsed", "parsed")
        )
      })
  )
})
