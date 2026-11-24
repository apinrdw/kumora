import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"

import { ArchiveDb } from "@/server/archive/archive-db"
import { type ArchiveSource, RUNS_PREFIX, RunId } from "@/server/archive/run"
import { startRunOf } from "@/server/archive/runs"
import {
  ArchiveRunResult,
  ArchiveTrigger,
  runIdAt,
  runningResult,
  RunSummary,
} from "@/server/shareholding/run-result"
import {
  lastRun,
  scheduledArchiveRun,
  startRun,
} from "@/server/shareholding/runs"

import { everySplit } from "../../interleaved"

import {
  latestRunId,
  runStores,
  SHAREHOLDING_ARCHIVE,
  seedRun,
  storedRun,
} from "./runs.ts"
import { readAlone } from "./read-alone.ts"

// 13:00 WIB on 14 November 2026.
const AFTERNOON = Date.parse("2026-11-14T06:00:00Z")

type Stores = ReturnType<typeof runStores>

const fire = ({ layer }: Stores, scheduledTime = AFTERNOON) =>
  scheduledArchiveRun(scheduledTime).pipe(Effect.provide(layer))

const started = ({ workflow }: Stores) => [...workflow.instances.keys()]

const stored = ({ db }: Stores, id: string) =>
  storedRun(db, SHAREHOLDING_ARCHIVE, id)

// The id of the last run while it is in progress.
const runInProgress = ({ layer }: Stores) =>
  readAlone(lastRun).pipe(
    Effect.map((view) =>
      view?.inProgress === true ? Option.some(view.result.id) : Option.none()
    ),
    Effect.provide(layer)
  )

describe("the archive cron", () => {
  it.effect("starts a run named after its scheduled hour", () =>
    Effect.gen(function* () {
      const archive = runStores()
      yield* fire(archive)

      assert.deepStrictEqual(started(archive), ["cron-2026-11-14T06"])
      assert.deepStrictEqual(
        archive.workflow.instances.get("cron-2026-11-14T06")?.options,
        {
          id: "cron-2026-11-14T06",
          params: { trigger: "cron" },
          retention: {
            successRetention: "30 days",
            errorRetention: "30 days",
          },
        }
      )
      assert.deepInclude(stored(archive, "cron-2026-11-14T06"), {
        outcome: "running",
      })
    })
  )

  for (const status of [
    "queued",
    "running",
    "waiting",
    "waitingForPause",
    "paused",
  ] as const)
    it.effect(`skips while the latest run is ${status}`, () =>
      Effect.gen(function* () {
        const archive = runStores()
        yield* fire(archive, Date.parse("2026-11-13T13:00:00Z"))
        const previous = archive.workflow.instances.get("cron-2026-11-13T13")
        assert.isDefined(previous)
        previous.status = status

        yield* fire(archive)

        assert.deepStrictEqual(started(archive), ["cron-2026-11-13T13"])
      })
    )

  for (const status of ["complete", "errored", "terminated"] as const)
    it.effect(`starts once the latest run is ${status}`, () =>
      Effect.gen(function* () {
        const archive = runStores()
        yield* fire(archive, Date.parse("2026-11-13T13:00:00Z"))
        const previous = archive.workflow.instances.get("cron-2026-11-13T13")
        assert.isDefined(previous)
        previous.status = status

        yield* fire(archive)

        assert.deepStrictEqual(started(archive), [
          "cron-2026-11-13T13",
          "cron-2026-11-14T06",
        ])
      })
    )

  it.effect("ignores a second firing for the same hour", () =>
    Effect.gen(function* () {
      const archive = runStores()
      yield* fire(archive)
      const first = archive.workflow.instances.get("cron-2026-11-14T06")
      assert.isDefined(first)
      first.status = "complete"

      yield* fire(archive)

      assert.deepStrictEqual(started(archive), ["cron-2026-11-14T06"])
      assert.strictEqual(first.status, "complete")
    })
  )

  it.effect(
    "leaves the record and the last run of a run a second firing finds",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        yield* fire(archive)
        const first = archive.workflow.instances.get("cron-2026-11-14T06")
        assert.isDefined(first)
        first.status = "complete"
        const ended = { ...stored(archive, "cron-2026-11-14T06") }
        ended["outcome"] = "complete"
        // The run ended, and an admin run came after it.
        seedRun(
          archive.db,
          SHAREHOLDING_ARCHIVE,
          ended as unknown as Parameters<typeof seedRun>[2]
        )
        yield* startRun(RunId.make("admin-1763125200000"), "admin").pipe(
          Effect.provide(archive.layer)
        )

        yield* fire(archive)

        assert.deepStrictEqual(stored(archive, "cron-2026-11-14T06"), ended)
        assert.strictEqual(
          latestRunId(archive.db, SHAREHOLDING_ARCHIVE),
          "admin-1763125200000"
        )
      })
  )

  for (const [label, minutesAgo, expected] of [
    ["skips while a start that claimed its run", 4, []],
    ["starts once a start that died after claiming its run", 6, ["cron"]],
  ] as const)
    it.effect(`${label} is ${minutesAgo} minutes old`, () =>
      Effect.gen(function* () {
        const archive = runStores()
        // The claim, with no instance: its start died before `create`.
        yield* TestClock.setTime(AFTERNOON - minutesAgo * 60 * 1000)
        archive.workflow.refuseCreate = true
        archive.workflow.onCreate = undefined
        yield* startRun(RunId.make("admin-1763125200000"), "admin").pipe(
          Effect.provide(archive.layer),
          Effect.ignore
        )
        // As if the refusal never got recorded: the start died there.
        const claimed = stored(archive, "admin-1763125200000")
        assert.isDefined(claimed)
        seedRun(
          archive.db,
          SHAREHOLDING_ARCHIVE,
          {
            ...claimed,
            outcome: "running",
            finishedAt: null,
            error: null,
          } as never,
          { latest: true }
        )
        archive.workflow.refuseCreate = false
        yield* TestClock.setTime(AFTERNOON)

        yield* fire(archive)

        assert.deepStrictEqual(
          started(archive),
          expected.length === 0 ? [] : ["cron-2026-11-14T06"]
        )
      })
    )

  it.effect("starts when the latest run is past its retention", () =>
    Effect.gen(function* () {
      const archive = runStores()
      // It never recorded how it ended, and its instance is gone.
      const startedAt = Date.parse("2026-10-01T06:00:00Z")
      yield* TestClock.setTime(startedAt)
      yield* fire(archive, startedAt)
      archive.workflow.instances.clear()
      yield* TestClock.setTime(AFTERNOON)

      yield* fire(archive)

      assert.deepStrictEqual(started(archive), ["cron-2026-11-14T06"])
    })
  )
})

// What Run now (apinrdw/kumora#309) builds on.
describe("starting a run by hand", () => {
  it.effect("names the run in progress, and nothing once it ends", () =>
    Effect.gen(function* () {
      const archive = runStores()
      const check = runInProgress(archive)
      assert.isTrue(Option.isNone(yield* check))

      yield* startRun(RunId.make("admin-1763125200000"), "admin").pipe(
        Effect.provide(archive.layer)
      )
      assert.deepStrictEqual(yield* check, Option.some("admin-1763125200000"))

      const run = archive.workflow.instances.get("admin-1763125200000")
      assert.isDefined(run)
      assert.deepStrictEqual(run.options, {
        id: "admin-1763125200000",
        params: { trigger: "admin" },
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      })
      run.status = "complete"
      assert.isTrue(Option.isNone(yield* check))
    })
  )

  it.effect(
    "keeps the record of a run that ended before the start returned",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        const id = RunId.make("admin-1763125200000")
        const ended = {
          id,
          trigger: "admin" as const,
          startedAt: "2026-11-14T13:00:00.000Z",
          finishedAt: "2026-11-14T13:00:30.000Z",
          outcome: "complete" as const,
          reportsAdded: 0,
          newVersions: 0,
          reportsChecked: 145,
          notStored: [],
          monthsParsed: 0,
          other: [],
          error: null,
        }
        // The run's steps all ran inside `create`: its summary wrote the
        // record.
        archive.workflow.onCreate = () =>
          seedRun(archive.db, SHAREHOLDING_ARCHIVE, ended, { latest: true })

        yield* startRun(id, "admin").pipe(Effect.provide(archive.layer))

        assert.deepStrictEqual(stored(archive, id), ended)
        assert.strictEqual(latestRunId(archive.db, SHAREHOLDING_ARCHIVE), id)
      })
  )

  it.effect(
    "records a run the Workflow refused to create as failed, and starts the next",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        const id = RunId.make("admin-1763125200000")
        archive.workflow.refuseCreate = true

        const exit = yield* Effect.exit(
          startRun(id, "admin").pipe(Effect.provide(archive.layer))
        )

        assert.isTrue(exit._tag === "Failure")
        assert.deepInclude(stored(archive, id), {
          outcome: "failed",
          error: "The Workflow refused to start the run.",
        })
        assert.isTrue(Option.isNone(yield* runInProgress(archive)))
      })
  )

  it.effect(
    "starts one run when Run now and the cron start at the same time",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.sync(runStores),
          first: (archive) => fire(archive),
          second: (archive) =>
            startRun(RunId.make("admin-1763125200000"), "admin").pipe(
              Effect.provide(archive.layer),
              Effect.ignore
            ),
          check: (archive, at) =>
            Effect.sync(() => {
              const ids = started(archive)
              assert.strictEqual(ids.length, 1, `split at ${at}`)
              assert.strictEqual(
                latestRunId(archive.db, SHAREHOLDING_ARCHIVE),
                ids[0]
              )
            }),
        })
        assert.isAbove(operations, 0)
      })
  )

  it.effect(
    "starts one run when two starts judge the same ended run at once",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.gen(function* () {
            const archive = runStores()
            yield* fire(archive, Date.parse("2026-11-14T05:00:00Z"))
            const previous =
              archive.workflow.instances.get("cron-2026-11-14T05")
            if (previous !== undefined) previous.status = "complete"
            return archive
          }),
          first: (archive) => fire(archive),
          second: (archive) =>
            startRun(RunId.make("admin-1763125200000"), "admin").pipe(
              Effect.provide(archive.layer),
              Effect.ignore
            ),
          check: (archive, at) =>
            Effect.sync(() => {
              const ids = started(archive).slice(1)
              assert.strictEqual(ids.length, 1, `split at ${at}`)
              assert.strictEqual(
                latestRunId(archive.db, SHAREHOLDING_ARCHIVE),
                ids[0]
              )
            }),
        })
        assert.isAbove(operations, 0)
      })
  )

  it.effect(
    "refuses a cron firing right after a start, before the run's plan step",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        yield* startRun(RunId.make("admin-1763125200000"), "admin").pipe(
          Effect.provide(archive.layer)
        )

        yield* fire(archive)

        assert.deepStrictEqual(started(archive), ["admin-1763125200000"])
        assert.strictEqual(
          stored(archive, "admin-1763125200000")?.["outcome"],
          "running"
        )
      })
  )

  it.effect(
    "fails a start whose row ArchiveDb refuses, rather than claiming again",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        // A record whose start no date parses from: its row breaks
        // started_at's NOT NULL, which is no claim lost to another start.
        const unparsed: ArchiveSource<
          ArchiveTrigger,
          RunSummary,
          ArchiveRunResult
        > = {
          runName: "Archive run",
          archive: "shareholding",
          runKind: "archive",
          runsPrefix: RUNS_PREFIX,
          triggers: ArchiveTrigger.literals,
          runIdAt,
          result: ArchiveRunResult,
          summary: RunSummary,
          kept: [],
          running: (run) =>
            Effect.map(runningResult(run), (record) => ({
              ...record,
              startedAt: "not a date",
            })),
        }

        const refused = yield* Effect.flip(
          startRunOf(unparsed, RunId.make("admin-1763125200000"), "admin").pipe(
            Effect.provide(archive.layer)
          )
        )

        assert.strictEqual(refused._tag, "ArchiveDbError")
        assert.deepStrictEqual(started(archive), [])
      })
  )

  it.effect(
    "gives up after a few claims lost to starts whose runs keep ending",
    () =>
      Effect.gen(function* () {
        const archive = runStores()
        let rivals = 0
        // Before each claim this start sends, another start claims a run
        // that ends at once, so the claim judged ended a run that no longer
        // holds it.
        const contended = Layer.effect(
          ArchiveDb,
          Effect.gen(function* () {
            const inner = yield* ArchiveDb
            return ArchiveDb.of({
              batch: (statements) =>
                Effect.suspend(() => {
                  if (statements.some(({ sql }) => sql.includes("latest)"))) {
                    rivals += 1
                    const id = RunId.make(`cron-rival-${rivals}`)
                    seedRun(
                      archive.db,
                      SHAREHOLDING_ARCHIVE,
                      ArchiveRunResult.make({
                        id,
                        trigger: "cron",
                        startedAt: new Date(
                          AFTERNOON + rivals * 1000
                        ).toISOString(),
                        finishedAt: null,
                        outcome: "running",
                        reportsAdded: 0,
                        newVersions: 0,
                        reportsChecked: 0,
                        notStored: [],
                        other: [],
                        error: null,
                      }),
                      { latest: true }
                    )
                    archive.workflow.instances.set(id, {
                      options: {
                        id,
                        params: { trigger: "cron" },
                        retention: {
                          successRetention: "30 days",
                          errorRetention: "30 days",
                        },
                      },
                      status: "complete",
                    })
                  }
                  return inner.batch(statements)
                }),
            })
          })
        ).pipe(Layer.provide(archive.db.layer))

        const refused = yield* Effect.flip(
          startRun(RunId.make("admin-1763125200000"), "admin").pipe(
            Effect.provide(Layer.merge(archive.layer, contended))
          )
        )

        assert.strictEqual(refused._tag, "RunInProgress")
        assert.isAtMost(rivals, 3)
        assert.isUndefined(stored(archive, "admin-1763125200000"))
      })
  )
})
