import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { ArchiveBucket, MAX_LISTED_OBJECTS } from "@/server/archive/bucket"
import { RunId } from "@/server/archive/run"
import { healShareholdingIndex } from "@/server/shareholding/report-index"
import { recentRuns } from "@/server/shareholding/runs"
import { archiveTotals } from "@/server/shareholding/totals"
import {
  type ArchiveRunResult,
  RunMetadata,
  type RunSummary,
} from "@/server/shareholding/run-result"

import { fakeWorkflow, type FakeWorkflow } from "../archive/fake-workflow.ts"
import { memoryArchiveDb } from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"

const NOW = Date.parse("2026-11-14T14:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

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
  uploaded?: number,
  customMetadata: Readonly<Record<string, string>> = {}
) =>
  bucket.objects.set(key, {
    body,
    contentType: "application/json",
    customMetadata,
    uploaded,
  })

const seedRun = (bucket: MemoryBucket, result: ArchiveRunResult) =>
  put(
    bucket,
    `runs/${result.id}.json`,
    JSON.stringify(result),
    Date.parse(result.finishedAt ?? result.startedAt),
    Schema.encodeSync(RunMetadata)({ run: result })
  )

const summary = (result: ArchiveRunResult): RunSummary => ({
  id: result.id,
  trigger: result.trigger,
  startedAt: result.startedAt,
  outcome: result.outcome,
  reportsAdded: result.reportsAdded,
  newVersions: result.newVersions,
})

const provide = (
  bucket: MemoryBucket,
  workflow: FakeWorkflow = fakeWorkflow()
) => Effect.provide(Layer.merge(bucket.layer, workflow.layer))

describe("the recent archive runs", () => {
  it.effect(
    "show a run whose Workflow errored before its summary as failed",
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
          { ...summary(crashed), outcome: "failed" },
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
      seedRun(bucket, result)
    put(bucket, "runs/latest.json", JSON.stringify({ id: newest.id }), NOW)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(
        yield* recentRuns,
        [newest, admin, failed, edge].map(summary)
      )
    }).pipe(provide(bucket))
  })

  it.effect("list only the runs of the past 30 days", () => {
    const bucket = memoryBucket()
    // Two cron runs and an admin run a day since 2025.
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
        const result = run(id, new Date(startedAt).toISOString())
        seedRun(bucket, result)
        if (startedAt >= NOW - 30 * DAY) recent.unshift(result)
      }
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, recent.map(summary))
      // At most a key per trigger past the 30 days, where a listing starts.
      assert.isAtMost(bucket.listed.length, recent.length + 2)
    }).pipe(provide(bucket))
  })

  it.effect(
    "read no record at the most runs the listings of runs/ hold",
    () => {
      const bucket = memoryBucket()
      // Each listing's cap of admin runs and an hourly cron run, all in the
      // past 30 days, each a partial run whose record lists URLs it couldn't
      // store.
      const seeded: Array<ArchiveRunResult> = []
      for (let index = 0; index < MAX_LISTED_OBJECTS; index++) {
        const startedAt = NOW - 1000 - index * 250_000
        seeded.push(
          run(
            `admin-${startedAt}`,
            new Date(startedAt).toISOString(),
            "partial"
          )
        )
      }
      for (let hour = 0; hour < 30 * 24; hour++) {
        const startedAt = new Date(NOW - hour * HOUR).toISOString()
        seeded.push(run(`cron-${startedAt.slice(0, 13)}`, startedAt, "partial"))
      }
      for (const result of seeded)
        seedRun(bucket, {
          ...result,
          notStored: Array.from(
            { length: 20 },
            (_, index) => `https://www.idx.id/${result.id}/${index}.xlsx`
          ),
        })
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        const runs = yield* recentRuns
        assert.strictEqual(bucket.gets.length, 0, "record bodies read")
        assert.deepStrictEqual(
          runs,
          [...seeded]
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
            .map(summary)
        )
      }).pipe(provide(bucket))
    },
    30_000
  )

  it.effect("leave out a record without its summary as metadata", () => {
    const bucket = memoryBucket()
    const bare = run("cron-2026-11-14T06", "2026-11-14T06:00:00.000Z")
    const summarized = run("cron-2026-11-14T13", "2026-11-14T13:00:00.000Z")
    put(bucket, `runs/${bare.id}.json`, JSON.stringify(bare), NOW)
    seedRun(bucket, summarized)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [summary(summarized)])
    }).pipe(provide(bucket))
  })

  it("carry a summary that fits R2's 2 KB of custom metadata", () => {
    const metadata = Schema.encodeSync(RunMetadata)({
      run: {
        ...run(`admin-${8_640_000_000_000_000}`, new Date(0).toISOString()),
        reportsAdded: Number.MAX_SAFE_INTEGER,
        newVersions: Number.MAX_SAFE_INTEGER,
      },
    })
    const bytes = Object.entries(metadata).reduce(
      (sum, [name, value]) =>
        sum + new TextEncoder().encode(name + value).length,
      0
    )
    assert.isBelow(bytes, 2048)
  })

  it.effect("include a run that's still running", () => {
    const bucket = memoryBucket()
    const running = run(
      "admin-1794664632000",
      "2026-11-14T13:57:12.000Z",
      "running"
    )
    seedRun(bucket, running)
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.deepStrictEqual(yield* recentRuns, [summary(running)])
    }).pipe(provide(bucket))
  })
})

// A version of a report as an archive run stores it: its file, then a
// 2-byte record per listing it was seen under (named by `listings`).
const report = (
  bucket: MemoryBucket,
  prefix: string,
  hash: string,
  bytes: number,
  listings: ReadonlyArray<string> = ["abcd"]
) => {
  const sha256 = hash.padStart(64, "0")
  put(bucket, `reports/${prefix}/${sha256}.xlsx`, "x".repeat(bytes))
  for (const listing of listings)
    put(
      bucket,
      `reports/${prefix}/${sha256}.2026-11-14T130000.000Z.${listing}.json`,
      "{}"
    )
}

// The totals once the report index holds what `bucket` does, as the next
// archive run's `plan` would index it.
const indexedTotals = (bucket: MemoryBucket) => {
  const db = memoryArchiveDb()
  return Effect.gen(function* () {
    yield* healShareholdingIndex(yield* (yield* ArchiveBucket).list("reports/"))
    return yield* archiveTotals
  }).pipe(Effect.provide(Layer.merge(bucket.layer, db.layer)))
}

describe("the archive totals", () => {
  it.effect("are zero for every report kind before any report", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* indexedTotals(memoryBucket()), {
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
    })
  )

  it.effect(
    "count each stored file per report kind, versions included, and the archive's size",
    () => {
      const bucket = memoryBucket()
      report(bucket, "above-5/2026-11-13", "aa", 100)
      // A new version of the same report.
      report(bucket, "above-5/2026-11-13", "bb", 120)
      report(bucket, "above-5/2026-11-14", "cc", 90)
      // One file seen under two listings: two records.
      report(bucket, "investor-type/2026-10-31", "dd", 300, ["abcd", "ef01"])
      report(bucket, "other/2026-11-12", "ee", 50)
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* indexedTotals(bucket), {
          kinds: [
            { kind: "above-5", reports: 3 },
            { kind: "above-1", reports: 0 },
            { kind: "investor-type", reports: 1 },
            { kind: "investor-classification", reports: 0 },
            { kind: "other", reports: 1 },
          ],
          reports: 5,
          // 660 bytes of files and six 2-byte records.
          bytes: 672,
        })
      })
    }
  )

  it.effect("count the largest archive the bucket lists", () => {
    const bucket = memoryBucket()
    for (let index = 0; index < MAX_LISTED_OBJECTS / 2; index++)
      report(bucket, "above-5/2026-11-13", String(index), 1)
    return Effect.gen(function* () {
      const totals = yield* indexedTotals(bucket)
      assert.strictEqual(totals.reports, MAX_LISTED_OBJECTS / 2)
      assert.strictEqual(totals.bytes, (MAX_LISTED_OBJECTS / 2) * 3)
    })
  })
})
