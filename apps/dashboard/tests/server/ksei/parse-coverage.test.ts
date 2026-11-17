// The KSEI parse run's parse coverage: each archived Securities holdings
// month's state, from the KSEI archive, the parsed holdings and the last
// finished KSEI parse run.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { kseiParseRuns } from "@/server/ksei/parse-runs"

import { localSteps } from "../archive/local-steps.ts"
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

// Today, so the grid ends in 2026.
const start = TestClock.setTime(Date.parse("2026-11-17T03:00:00Z"))

const archive = ({ ksei, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiArchiveRun(localSteps(Layer.merge(ksei.layer, bucket.layer)), {
        id: RunId.make(id),
        trigger: "cron",
        startedAt: new Date("2026-11-14T03:00:00Z"),
      })
    )
  )

const parse = ({ bucket, holdings }: World, id: string, startedAt: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      kseiParseRuns.run(localSteps(Layer.merge(bucket.layer, holdings.layer)), {
        id: RunId.make(id),
        trigger: id.startsWith("admin") ? "admin" : "cron",
        startedAt: new Date(startedAt),
      })
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

// The coverage as each year's twelve cells, a cell its state or "" when
// blank.
const coverage = ({ bucket, holdings }: World) =>
  kseiParseRuns.coverage.pipe(
    Effect.provide(Layer.merge(bucket.layer, holdings.layer)),
    Effect.map((years) =>
      Object.fromEntries(
        years.map(({ year, months }) => [
          year,
          months.map((month): string => month?.state ?? ""),
        ])
      )
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
      assert.deepStrictEqual(yield* coverage(world()), {})
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
          yield* coverage(w),
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
        yield* coverage(w),
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
        yield* coverage(w),
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
        yield* coverage(w),
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
        yield* coverage(w),
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
        yield* coverage(w),
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
        w.bucket.objects.set("parse-runs/admin-1763434800000.json", {
          body: JSON.stringify({
            id: "admin-1763434800000",
            trigger: "admin",
            startedAt: "2026-11-15T03:00:00.000Z",
            finishedAt: null,
            outcome: "running",
            monthsParsed: 0,
            parseFailures: [],
            error: null,
          }),
          contentType: "application/json",
          customMetadata: {},
        })
        assert.deepStrictEqual(
          yield* coverage(w),
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
          yield* coverage(w),
          may2026("parsed", "parsed", "parsed", "parsed")
        )
      })
  )

  it.effect("shows a month's later date when two share its month", () =>
    Effect.gen(function* () {
      yield* start
      const w = world()
      yield* archive(w, "cron-2026-11-14")
      yield* parse(w, "cron-2026-11-14", "2026-11-14T04:00:00Z")
      // A record of a report dated 2026-10-31, never parsed.
      w.bucket.objects.set(
        `reports/securities-holdings/2026-10-31/${"a".repeat(64)}.2026-11-17T050000.000Z.0123456789abcdef.json`,
        { body: "{}", contentType: "application/json", customMetadata: {} }
      )
      const years = yield* kseiParseRuns.coverage.pipe(
        Effect.provide(Layer.merge(w.bucket.layer, w.holdings.layer))
      )
      assert.deepStrictEqual(years[0]?.months[9], {
        date: "2026-10-31",
        state: "not-parsed",
      })
    })
  )
})
