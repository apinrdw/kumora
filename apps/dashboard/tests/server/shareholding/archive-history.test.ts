import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { MAX_LISTED_OBJECTS } from "@/server/archive/bucket"
import { RunId } from "@/server/archive/run"
import { recentRuns } from "@/server/shareholding/runs"
import { archiveTotals } from "@/server/shareholding/totals"
import type {
  ArchiveRunResult,
  RunSummary,
} from "@/server/shareholding/run-result"

import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import { runStores, SHAREHOLDING_ARCHIVE, seedRun } from "../archive/runs.ts"

const NOW = Date.parse("2026-11-14T14:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Stores = ReturnType<typeof runStores>

const run = (
  id: string,
  startedAt: string,
  outcome: ArchiveRunResult["outcome"] = "complete"
): ArchiveRunResult => ({
  id: RunId.make(id),
  trigger: id.startsWith("cron") ? "cron" : "admin",
  startedAt,
  finishedAt: outcome === "running" ? null : startedAt,
  outcome,
  reportsAdded: 1,
  newVersions: 0,
  reportsChecked: 147,
  notStored: [],
  monthsParsed: 0,
  parseFailures: [],
  other: [],
  error: null,
})

const put = (
  bucket: MemoryBucket,
  key: string,
  body: string,
  uploaded?: number
) =>
  bucket.objects.set(key, {
    body,
    contentType: "application/json",
    customMetadata: {},
    uploaded,
  })

const seed = ({ db }: Stores, result: ArchiveRunResult) =>
  seedRun(db, SHAREHOLDING_ARCHIVE, result)

const summary = (result: ArchiveRunResult): RunSummary => ({
  id: result.id,
  trigger: result.trigger,
  startedAt: result.startedAt,
  outcome: result.outcome,
  reportsAdded: result.reportsAdded,
  newVersions: result.newVersions,
})

const provideRuns = ({ layer }: Stores) => Effect.provide(layer)

const provide = (bucket: MemoryBucket) => Effect.provide(bucket.layer)

describe("the recent archive runs", () => {
  it.effect(
    "show a run whose Workflow errored before its summary as failed",
    () => {
      const archive = runStores()
      const crashed = run(
        "cron-2026-11-14T06",
        "2026-11-14T06:00:00.000Z",
        "running"
      )
      seed(archive, crashed)
      archive.workflow.instances.set(crashed.id, {
        options: {
          id: crashed.id,
          params: { trigger: "cron" },
          retention: { successRetention: "30 days", errorRetention: "30 days" },
        },
        status: "errored",
        error: "Worker exceeded its memory limit",
      })
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        assert.deepStrictEqual(yield* recentRuns, [
          { ...summary(crashed), outcome: "failed" },
        ])
      }).pipe(provideRuns(archive))
    }
  )

  it.effect("are none before any run", () => {
    const archive = runStores()
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [])
    }).pipe(provideRuns(archive))
  })

  it.effect("are the past 30 days of runs, newest first", () => {
    const archive = runStores()
    const newest = run("cron-2026-11-14T13", "2026-11-14T13:00:00.000Z")
    const failed = run(
      "cron-2026-11-13T06",
      "2026-11-13T06:00:00.000Z",
      "failed"
    )
    const admin = run(
      "admin-1794561544000",
      "2026-11-13T09:19:04.000Z",
      "partial"
    )
    const edge = run(
      "cron-2026-10-15T15",
      new Date(NOW - 30 * DAY + 60_000).toISOString()
    )
    const old = run("cron-2026-10-15T06", "2026-10-15T06:00:00.000Z")
    for (const result of [old, failed, newest, edge, admin])
      seed(archive, result)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(
        yield* recentRuns,
        [newest, admin, failed, edge].map(summary)
      )
    }).pipe(provideRuns(archive))
  })

  it.effect(
    "list only the runs of the past 30 days, however many came before",
    () => {
      const archive = runStores()
      // Two cron runs and an admin run a day since 2025.
      const recent: Array<ArchiveRunResult> = []
      for (let day = Date.parse("2025-01-01"); day < NOW; day += DAY)
        for (const [id, startedAt] of [
          [
            `cron-${new Date(day).toISOString().slice(0, 10)}T06`,
            day + 6 * HOUR,
          ],
          [`admin-${day + 9 * HOUR}`, day + 9 * HOUR],
          [
            `cron-${new Date(day).toISOString().slice(0, 10)}T13`,
            day + 13 * HOUR,
          ],
        ] as const) {
          if (startedAt > NOW) continue
          const result = run(id, new Date(startedAt).toISOString())
          seed(archive, result)
          if (startedAt >= NOW - 30 * DAY) recent.unshift(result)
        }
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        assert.deepStrictEqual(yield* recentRuns, recent.map(summary))
      }).pipe(provideRuns(archive))
    }
  )

  it.effect("pass over a record that no longer decodes", () => {
    const archive = runStores()
    const kept = run("cron-2026-11-14T13", "2026-11-14T13:00:00.000Z")
    seed(archive, kept)
    seed(archive, {
      ...run("cron-2026-11-14T06", "2026-11-14T06:00:00.000Z"),
      reportsAdded: "many" as unknown as number,
    })
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [summary(kept)])
    }).pipe(provideRuns(archive))
  })

  it.effect("include a run that's still running", () => {
    const archive = runStores()
    const running = run(
      "admin-1794664632000",
      "2026-11-14T13:57:12.000Z",
      "running"
    )
    seed(archive, running)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [summary(running)])
    }).pipe(provideRuns(archive))
  })
})

const report = (
  bucket: MemoryBucket,
  prefix: string,
  hash: string,
  bytes: number
) => {
  put(bucket, `reports/${prefix}/${hash}.xlsx`, "x".repeat(bytes))
  put(bucket, `reports/${prefix}/${hash}.20261114T130000000Z.abcd.json`, "{}")
}

describe("the archive totals", () => {
  it.effect("are zero for every report kind before any report", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* archiveTotals, {
        kinds: [
          { kind: "above-5", reports: 0 },
          { kind: "above-1", reports: 0 },
          { kind: "investor-type", reports: 0 },
          { kind: "investor-classification", reports: 0 },
          { kind: "other", reports: 0 },
        ],
        reports: 0,
        bytes: 0,
      })
    }).pipe(provide(memoryBucket()))
  )

  it.effect(
    "count each stored file per report kind, versions included, and the archive's size",
    () => {
      const bucket = memoryBucket()
      report(bucket, "above-5/2026-11-13", "aa", 100)
      // A new version of the same report.
      report(bucket, "above-5/2026-11-13", "bb", 120)
      report(bucket, "above-5/2026-11-14", "cc", 90)
      report(bucket, "investor-type/2026-10-31", "dd", 300)
      report(bucket, "other/2026-11-12", "ee", 50)
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* archiveTotals, {
          kinds: [
            { kind: "above-5", reports: 3 },
            { kind: "above-1", reports: 0 },
            { kind: "investor-type", reports: 1 },
            { kind: "investor-classification", reports: 0 },
            { kind: "other", reports: 1 },
          ],
          reports: 5,
          // 660 bytes of files and five 2-byte records.
          bytes: 670,
        })
      }).pipe(provide(bucket))
    }
  )

  it.effect("count the largest archive the bucket lists", () => {
    const bucket = memoryBucket()
    for (let index = 0; index < MAX_LISTED_OBJECTS / 2; index++)
      report(bucket, "above-5/2026-11-13", String(index).padStart(64, "0"), 1)
    return Effect.gen(function* () {
      const totals = yield* archiveTotals
      assert.strictEqual(totals.reports, MAX_LISTED_OBJECTS / 2)
      assert.strictEqual(totals.bytes, (MAX_LISTED_OBJECTS / 2) * 3)
    }).pipe(provide(bucket))
  })
})
