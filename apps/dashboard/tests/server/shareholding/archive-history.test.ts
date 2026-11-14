import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { archiveTotals, recentRuns } from "@/server/shareholding/history"
import {
  ArchiveRunId,
  type ArchiveRunResult,
} from "@/server/shareholding/run-result"

import { fakeWorkflow, type FakeWorkflow } from "./fake-workflow.ts"
import { type MemoryBucket, memoryBucket } from "./memory-bucket.ts"

const NOW = Date.parse("2026-11-14T14:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

const run = (
  id: string,
  startedAt: string,
  outcome: ArchiveRunResult["outcome"] = "complete"
): ArchiveRunResult => ({
  id: ArchiveRunId.make(id),
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

const provide = (
  bucket: MemoryBucket,
  workflow: FakeWorkflow = fakeWorkflow()
) => Effect.provide(Layer.merge(bucket.layer, workflow.layer))

describe("the recent archive runs", () => {
  it.effect(
    "show a run whose Workflow errored before its summary as failed, with its error",
    () => {
      const bucket = memoryBucket()
      const workflow = fakeWorkflow()
      const crashed = run(
        "cron-2026-11-14T06",
        "2026-11-14T06:00:00.000Z",
        "running"
      )
      seedRun(bucket, crashed)
      workflow.instances.set(crashed.id, {
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
          {
            ...crashed,
            outcome: "failed",
            error: "Worker exceeded its memory limit",
          },
        ])
      }).pipe(provide(bucket, workflow))
    }
  )

  it.effect("are none before any run", () => {
    const bucket = memoryBucket()
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [])
    }).pipe(provide(bucket))
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
    }).pipe(provide(bucket))
  })

  it.effect("list and read only the runs of the past 30 days", () => {
    const bucket = memoryBucket()
    // Two cron runs and an admin run a day since 2025. A record older than
    // the 30 days isn't JSON, so reading one fails the test.
    const recent: Array<ArchiveRunResult> = []
    for (let day = Date.parse("2025-01-01"); day < NOW; day += DAY)
      for (const [id, startedAt] of [
        [`cron-${new Date(day).toISOString().slice(0, 10)}T06`, day + 6 * HOUR],
        [`admin-${day + 9 * HOUR}`, day + 9 * HOUR],
        [
          `cron-${new Date(day).toISOString().slice(0, 10)}T13`,
          day + 13 * HOUR,
        ],
      ] as const) {
        if (startedAt > NOW) continue
        if (startedAt < NOW - 30 * DAY) {
          put(bucket, `runs/${id}.json`, "not json", startedAt)
          continue
        }
        const result = run(id, new Date(startedAt).toISOString())
        seedRun(bucket, result)
        recent.unshift(result)
      }
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, recent)
      // At most a key per trigger past the 30 days, where a listing starts.
      assert.isAtMost(bucket.listed.length, recent.length + 2)
    }).pipe(provide(bucket))
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
    }).pipe(provide(bucket))
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
})
