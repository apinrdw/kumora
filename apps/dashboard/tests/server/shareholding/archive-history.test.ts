import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { archiveTotals, recentRuns } from "@/server/shareholding/history"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

import { type MemoryBucket, memoryBucket } from "./memory-bucket.ts"

const NOW = Date.parse("2026-11-14T14:00:00.000Z")
const DAY = 86_400_000

const run = (
  id: string,
  startedAt: string,
  outcome: ArchiveRunResult["outcome"] = "complete"
): ArchiveRunResult => ({
  id,
  trigger: id.startsWith("cron") ? "cron" : "admin",
  startedAt,
  finishedAt: outcome === "running" ? null : startedAt,
  outcome,
  reportsAdded: 1,
  newVersions: 0,
  reportsChecked: 147,
  notStored: [],
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

const seedRun = (bucket: MemoryBucket, result: ArchiveRunResult) =>
  put(
    bucket,
    `runs/${result.id}.json`,
    JSON.stringify(result),
    Date.parse(result.finishedAt ?? result.startedAt)
  )

describe("the recent archive runs", () => {
  it.effect("are none before any run", () => {
    const bucket = memoryBucket()
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [])
    }).pipe(Effect.provide(bucket.layer))
  })

  it.effect("are the past 30 days of runs, newest first", () => {
    const bucket = memoryBucket()
    const newest = run("cron-2026-11-14T13", "2026-11-14T13:00:00.000Z")
    const failed = run(
      "cron-2026-11-13T06",
      "2026-11-13T06:00:00.000Z",
      "failed"
    )
    const admin = run(
      "admin-1763025544000",
      "2026-11-13T09:19:04.000Z",
      "partial"
    )
    const edge = run(
      "cron-2026-10-15T15",
      new Date(NOW - 30 * DAY + 60_000).toISOString()
    )
    const old = run("cron-2026-10-15T06", "2026-10-15T06:00:00.000Z")
    for (const result of [old, failed, newest, edge, admin])
      seedRun(bucket, result)
    put(bucket, "runs/latest.json", JSON.stringify({ id: newest.id }), NOW)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [newest, admin, failed, edge])
    }).pipe(Effect.provide(bucket.layer))
  })

  it.effect("read no record last written before the 30 days", () => {
    const bucket = memoryBucket()
    // A record whose body claims a recent start but that R2 last wrote long
    // ago is never read: the listing alone rules it out.
    put(bucket, "runs/cron-2026-11-14T06.json", "not json", NOW - 31 * DAY)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [])
    }).pipe(Effect.provide(bucket.layer))
  })

  it.effect("include a run that's still running", () => {
    const bucket = memoryBucket()
    const running = run(
      "admin-1763128632000",
      "2026-11-14T13:57:12.000Z",
      "running"
    )
    seedRun(bucket, running)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [running])
    }).pipe(Effect.provide(bucket.layer))
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
    }).pipe(Effect.provide(memoryBucket().layer))
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
      }).pipe(Effect.provide(bucket.layer))
    }
  )
})
