import { assert, describe, it } from "@effect/vitest"
import { STEP_RESULT_BYTES } from "@workspace/server"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { ArchiveDb } from "@/server/archive/archive-db"
import { ArchiveBucket } from "@/server/archive/bucket"
import { RECORDS_AT_ONCE } from "@/server/archive/run-import"
import { RunId } from "@/server/archive/run"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"
import {
  lastRun as lastRunRead,
  recentRuns as recentRunsRead,
  startRun,
} from "@/server/shareholding/runs"

import type { FakeInstance, FakeWorkflow } from "./fake-workflow.ts"
import { everySplit } from "../../interleaved"

import {
  latestRunId,
  runCount,
  runStores,
  SHAREHOLDING_ARCHIVE,
  seedRun,
} from "./runs.ts"
import { readAlone } from "./read-alone.ts"

const lastRun = readAlone(lastRunRead)

const recentRuns = Effect.flatMap(DateTime.now, (now) =>
  readAlone(recentRunsRead(now))
)

const RUNNING: ArchiveRunResult = {
  id: RunId.make("admin-1763125032000"),
  trigger: "admin",
  startedAt: "2026-11-14T13:17:12.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  notStored: [],
  other: [],
  error: null,
}

const COMPLETE: ArchiveRunResult = {
  ...RUNNING,
  id: RunId.make("cron-2026-11-14T13"),
  trigger: "cron",
  startedAt: "2026-11-14T13:00:00.000Z",
  finishedAt: "2026-11-14T13:01:12.000Z",
  outcome: "complete",
  reportsAdded: 2,
  reportsChecked: 147,
}

type Stores = ReturnType<typeof runStores>

const seed = ({ db }: Stores, run: ArchiveRunResult) =>
  seedRun(db, SHAREHOLDING_ARCHIVE, run, { latest: true })

const instance = (workflow: FakeWorkflow, id: string) => {
  const created: FakeInstance = {
    options: {
      id: RunId.make(id),
      params: { trigger: "admin" },
      retention: { successRetention: "30 days", errorRetention: "30 days" },
    },
    status: "queued",
  }
  workflow.instances.set(id, created)
  return created
}

const provide = ({ layer }: Stores) => Effect.provide(layer)

// Shortly after RUNNING started.
const AFTER_START = Date.parse("2026-11-14T13:18:00.000Z")

describe("the last archive run", () => {
  it.effect("is none before any run", () => {
    const archive = runStores()
    return Effect.gen(function* () {
      assert.isUndefined(yield* lastRun)
    }).pipe(provide(archive))
  })

  it.effect("is the run its last start claimed", () => {
    const archive = runStores()
    seed(archive, COMPLETE)
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* lastRun, {
        result: COMPLETE,
        inProgress: false,
        workflowStatus: null,
      })
    }).pipe(provide(archive))
  })

  it.effect(
    "reads a run recorded while archive runs still parsed months",
    () => {
      const archive = runStores()
      const recordedThen: ArchiveRunResult = {
        ...COMPLETE,
        outcome: "partial",
        monthsParsed: 3,
        parseFailures: [{ date: "2026-10-30", message: "No TOTAL SCRIPLESS" }],
      }
      seed(archive, recordedThen)
      return Effect.gen(function* () {
        assert.deepStrictEqual((yield* lastRun)?.result, recordedThen)
      }).pipe(provide(archive))
    }
  )

  it.effect("carries a running run's live Workflow status", () => {
    const archive = runStores()
    seed(archive, RUNNING)
    instance(archive.workflow, RUNNING.id).status = "waiting"
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* lastRun, {
        result: RUNNING,
        inProgress: true,
        workflowStatus: "waiting",
      })
    }).pipe(provide(archive))
  })

  it.effect(
    "shows a run whose Workflow errored as failed, with its error",
    () => {
      const archive = runStores()
      seed(archive, RUNNING)
      const errored = instance(archive.workflow, RUNNING.id)
      errored.status = "errored"
      errored.error = "www.idx.id answered 403"
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* lastRun, {
          result: {
            ...RUNNING,
            outcome: "failed",
            error: "www.idx.id answered 403",
          },
          inProgress: false,
          workflowStatus: "errored",
        })
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "trusts the record of a running run the Workflow doesn't hold, within its retention",
    () => {
      const archive = runStores()
      seed(archive, RUNNING)
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_START)
        assert.deepStrictEqual(yield* lastRun, {
          result: RUNNING,
          inProgress: true,
          workflowStatus: null,
        })
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "shows a run still running past its retention as failed, so it never blocks a new one",
    () => {
      const archive = runStores()
      seed(archive, RUNNING)
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-12-15T00:00:00.000Z"))
        const run = yield* lastRun
        assert.strictEqual(run?.result.outcome, "failed")
        assert.isFalse(run?.inProgress)
      }).pipe(provide(archive))
    }
  )
})

// A stage whose runs were only in R2 when ArchiveDb began to hold them.
describe("the cutover import", () => {
  const putJson = (
    { bucket }: Stores,
    key: string,
    value: unknown,
    customMetadata: Readonly<Record<string, string>> = {}
  ) =>
    bucket.objects.set(key, {
      body: JSON.stringify(value),
      contentType: "application/json",
      customMetadata,
    })

  const inR2 = (archive: Stores, run: ArchiveRunResult) =>
    putJson(archive, `runs/${run.id}.json`, run)

  const NOW = Date.parse("2026-11-14T14:00:00.000Z")
  const DAY = 24 * 3_600_000

  const old = {
    ...COMPLETE,
    id: RunId.make("cron-2026-10-01T06"),
    startedAt: "2026-10-01T06:00:00.000Z",
  }
  const recent = {
    ...COMPLETE,
    id: RunId.make("cron-2026-11-01T06"),
    startedAt: "2026-11-01T06:00:00.000Z",
  }

  it.effect(
    "shows the latest run and the past 30 days on first load, and imports nothing on the second",
    () => {
      const archive = runStores()
      for (const run of [old, recent, COMPLETE]) inR2(archive, run)
      putJson(archive, "runs/latest.json", { id: COMPLETE.id })
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        assert.deepStrictEqual((yield* lastRun)?.result, COMPLETE)
        assert.deepStrictEqual(
          (yield* recentRuns).map(({ id }) => id),
          [COMPLETE.id, recent.id]
        )

        // A record R2 gains after the import is never read.
        inR2(archive, {
          ...COMPLETE,
          id: RunId.make("cron-2026-11-14T06"),
          startedAt: "2026-11-14T06:00:00.000Z",
        })
        archive.bucket.gets.length = 0
        archive.bucket.listed.length = 0
        assert.deepStrictEqual((yield* lastRun)?.result, COMPLETE)
        assert.deepStrictEqual(
          (yield* recentRuns).map(({ id }) => id),
          [COMPLETE.id, recent.id]
        )
        assert.deepStrictEqual(archive.bucket.gets, [])
        assert.deepStrictEqual(archive.bucket.listed, [])
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "imports the latest run however old, and leaves R2 as it was",
    () => {
      const archive = runStores()
      inR2(archive, old)
      putJson(archive, "runs/latest.json", { id: old.id })
      const before = new Map(archive.bucket.objects)
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW + 40 * DAY)
        assert.deepStrictEqual((yield* lastRun)?.result, old)
        assert.deepStrictEqual(yield* recentRuns, [])
        assert.deepStrictEqual(archive.bucket.puts, [])
        assert.deepStrictEqual(archive.bucket.objects, before)
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "is done before a start claims, so a run in progress in R2 refuses it",
    () => {
      const archive = runStores()
      inR2(archive, RUNNING)
      putJson(archive, "runs/latest.json", { id: RUNNING.id })
      instance(archive.workflow, RUNNING.id).status = "running"
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_START)
        const refused = yield* Effect.flip(
          startRun(RunId.make("admin-1763125100000"), "admin")
        )
        assert.strictEqual(refused._tag, "RunInProgress")
        assert.deepStrictEqual(
          [...archive.workflow.instances.keys()],
          [RUNNING.id]
        )
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "imports again on the next load after an import that failed halfway",
    () => {
      const archive = runStores()
      for (const run of [old, recent, COMPLETE]) inR2(archive, run)
      putJson(archive, "runs/latest.json", { id: COMPLETE.id })
      // The batch that marks the kind imported fails, after its rows went in.
      archive.db.failBatch = (sql) =>
        sql.some((each) => each.includes("INTO run_import"))
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        const failed = yield* Effect.flip(lastRun)
        assert.strictEqual(failed._tag, "ArchiveDbError")

        archive.db.failBatch = undefined
        assert.deepStrictEqual((yield* lastRun)?.result, COMPLETE)
        assert.deepStrictEqual(
          (yield* recentRuns).map(({ id }) => id),
          [COMPLETE.id, recent.id]
        )
        assert.strictEqual(
          latestRunId(archive.db, SHAREHOLDING_ARCHIVE),
          COMPLETE.id
        )
      }).pipe(provide(archive))
    }
  )

  it.effect(
    "imports once when two first loads race",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        const operations = yield* everySplit({
          setup: Effect.sync(() => {
            const archive = runStores()
            for (const run of [old, recent, COMPLETE]) inR2(archive, run)
            putJson(archive, "runs/latest.json", { id: COMPLETE.id })
            return { archive, seen: [] as Array<unknown> }
          }),
          first: ({ archive, seen }) =>
            Effect.map(lastRun, (view) => seen.push(view?.result.id)).pipe(
              provide(archive)
            ),
          second: ({ archive, seen }) =>
            Effect.map(recentRuns, (runs) =>
              seen.push(runs.map(({ id }) => id))
            ).pipe(provide(archive)),
          check: ({ archive, seen }, at) =>
            Effect.sync(() => {
              assert.sameDeepMembers(
                seen,
                [COMPLETE.id, [COMPLETE.id, recent.id]],
                `split at ${at}`
              )
              assert.strictEqual(
                latestRunId(archive.db, SHAREHOLDING_ARCHIVE),
                COMPLETE.id,
                `split at ${at}`
              )
              assert.strictEqual(
                runCount(archive.db, SHAREHOLDING_ARCHIVE),
                2,
                `split at ${at}`
              )
            }),
        })
        assert.isAbove(operations, 0)
      }),
    20_000
  )

  it.effect(
    "holds at most RECORDS_AT_ONCE records read from R2 and not yet in ArchiveDb, at the largest import",
    () => {
      const archive = runStores()
      // 31 days of hourly cron runs, each record as large as a run's summary
      // step can return. The bucket holds them small, and pads each as it is
      // read, so the test holds no more of them than the import does.
      const HOUR = 3_600_000
      const padding = "x".repeat(STEP_RESULT_BYTES - 1024)
      for (let hour = 0; hour < 31 * 24; hour++) {
        const startedAt = new Date(NOW - hour * HOUR).toISOString()
        inR2(archive, {
          ...COMPLETE,
          id: RunId.make(`cron-${startedAt.slice(0, 13)}`),
          startedAt,
        })
      }
      putJson(archive, "runs/latest.json", { id: "cron-2026-11-14T14" })
      let held = 0
      let mostHeld = 0
      const padded = Layer.effect(
        ArchiveBucket,
        Effect.gen(function* () {
          const inner = yield* ArchiveBucket
          return ArchiveBucket.of({
            ...inner,
            get: (key) =>
              Effect.map(inner.get(key), (object) => {
                if (object === undefined || !key.includes("cron-"))
                  return object
                const body = JSON.stringify({
                  ...JSON.parse(object.body),
                  notStored: [padding],
                })
                held += body.length
                mostHeld = Math.max(mostHeld, held)
                return { ...object, body }
              }),
          })
        })
      ).pipe(Layer.provide(archive.bucket.layer))
      const unpadded = Layer.effect(
        ArchiveDb,
        Effect.gen(function* () {
          const inner = yield* ArchiveDb
          return ArchiveDb.of({
            batch: (statements) =>
              inner.batch(
                statements.map((statement) => {
                  const record = statement.params[6]
                  if (!statement.sql.includes("INTO run (")) return statement
                  if (typeof record !== "string") return statement
                  held -= record.length
                  const params = [...statement.params]
                  params[6] = JSON.stringify({
                    ...JSON.parse(record),
                    notStored: [],
                  })
                  return { ...statement, params }
                })
              ),
          })
        })
      ).pipe(Layer.provide(archive.db.layer))
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        assert.strictEqual((yield* lastRun)?.result.id, "cron-2026-11-14T14")
        assert.strictEqual(
          runCount(archive.db, SHAREHOLDING_ARCHIVE),
          30 * 24 + 1
        )
        assert.isAtMost(mostHeld, RECORDS_AT_ONCE * STEP_RESULT_BYTES)
      }).pipe(
        Effect.provide(Layer.mergeAll(padded, unpadded, archive.workflow.layer))
      )
    },
    60_000
  )

  it.effect("imports nothing on a fresh stage, and only once", () => {
    const archive = runStores()
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      assert.isUndefined(yield* lastRun)
      archive.bucket.listed.length = 0
      archive.bucket.gets.length = 0
      // Runs left in R2 after the import, as by an older deploy, stay there.
      inR2(archive, recent)
      putJson(archive, "runs/latest.json", { id: recent.id })
      assert.isUndefined(yield* lastRun)
      assert.deepStrictEqual(yield* recentRuns, [])
      assert.deepStrictEqual(archive.bucket.gets, [])
    }).pipe(provide(archive))
  })
})
