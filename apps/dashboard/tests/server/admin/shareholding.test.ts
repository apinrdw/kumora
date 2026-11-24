import type { SQLInputValue } from "node:sqlite"

import { assert, describe, it } from "@effect/vitest"
import { Conflict, STEP_RESULT_BYTES, Unauthorized } from "@workspace/server"
import { Effect, Layer, Logger, References } from "effect"
import { TestClock } from "effect/testing"

import {
  parseAbove1Now,
  parseClassificationNow,
  parseInvestorTypeNow,
  runArchiveNow,
  shareholdingArchivePage,
} from "@/server/admin/shareholding"
import type { Mail } from "@/server/auth/mailer"
import { ArchiveDb } from "@/server/archive/archive-db"
import { ArchiveBucket } from "@/server/archive/bucket"
import { RunId } from "@/server/archive/run"
import { ArchiveWorkflow } from "@/server/archive/workflow"
import type { Statement } from "@/server/d1"
import type { ParseRunResult } from "@/server/holdings/parse-run-result"
import { Above1ParseWorkflow } from "@/server/shareholding/above-1-parse"
import { ClassificationParseWorkflow } from "@/server/shareholding/classification-parse"
import { InvestorTypeParseWorkflow } from "@/server/shareholding/investor-type-parse"
import { recordKey, reportKey } from "@/server/shareholding/keys"
import type { ReportKind } from "@/server/shareholding/listing"
import { shareholdingIndex } from "@/server/shareholding/report-index"
import {
  type ArchiveRunResult,
  RunSummary,
} from "@/server/shareholding/run-result"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"
import { fakeWorkflow, type FakeWorkflow } from "../archive/fake-workflow.ts"
import {
  type MemoryArchiveDb,
  memoryArchiveDb,
} from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  latestRunId,
  SHAREHOLDING_ARCHIVE,
  seedRun,
  shareholdingParse,
} from "../archive/runs.ts"
import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string, name: string) {
    yield* post("/sign-up/email", {
      email,
      password: "correct horse",
      name,
      callbackURL: "/",
    })
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

const RUNNING: ArchiveRunResult = {
  id: RunId.make("cron-2026-11-14T13"),
  trigger: "cron",
  startedAt: "2026-11-14T13:00:00.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  notStored: [],
  other: [],
  error: null,
}

const seedLatest = (db: MemoryArchiveDb, run: ArchiveRunResult) =>
  seedRun(db, SHAREHOLDING_ARCHIVE, run, { latest: true })

// A version of a report as an archive run stores it: its file, then its
// record.
const storeReport = (
  bucket: MemoryBucket,
  kind: ReportKind,
  dataDate: string,
  sha256: string,
  file: string,
  record = "{}"
) =>
  Effect.gen(function* () {
    const put = (key: string, body: string) =>
      bucket.objects.set(key, {
        body,
        contentType: "application/octet-stream",
        customMetadata: {},
      })
    put(yield* reportKey(kind, dataDate, sha256), file)
    put(
      yield* recordKey(kind, dataDate, sha256, "2026-11-14T13:00:00.000Z", {
        sourceUrl: `https://www.idx.co.id/Media/${sha256}.xlsx`,
        etag: null,
      }),
      record
    )
  })

const archive = () => {
  const auth = seam()
  const bucket = memoryBucket()
  const db = memoryArchiveDb()
  const workflow = fakeWorkflow()
  // Each parse run's own Workflow.
  const classificationWorkflow = fakeWorkflow()
  const investorTypeWorkflow = fakeWorkflow()
  const above1Workflow = fakeWorkflow()
  return {
    ...auth,
    bucket,
    db,
    workflow,
    classificationWorkflow,
    investorTypeWorkflow,
    above1Workflow,
    // The report index gains what the bucket holds, as the next archive
    // run's `plan` would index it.
    indexed: Effect.gen(function* () {
      yield* shareholdingIndex.heal(
        yield* (yield* ArchiveBucket).list("reports/")
      )
    }).pipe(Effect.provide(Layer.merge(bucket.layer, db.layer))),
    layer: Layer.mergeAll(
      auth.layer,
      bucket.layer,
      db.layer,
      memoryHoldingsDb().layer,
      workflow.layer,
      Layer.effect(
        ClassificationParseWorkflow,
        Effect.service(ArchiveWorkflow)
      ).pipe(Layer.provide(classificationWorkflow.layer)),
      Layer.effect(
        InvestorTypeParseWorkflow,
        Effect.service(ArchiveWorkflow)
      ).pipe(Layer.provide(investorTypeWorkflow.layer)),
      Layer.effect(Above1ParseWorkflow, Effect.service(ArchiveWorkflow)).pipe(
        Layer.provide(above1Workflow.layer)
      )
    ),
  }
}

const createdIds = (workflow: FakeWorkflow) => [...workflow.instances.keys()]

const runningInstance = (workflow: FakeWorkflow, id: string) =>
  workflow.instances.set(id, {
    options: {
      id: RunId.make(id),
      params: { trigger: "cron" },
      retention: { successRetention: "30 days", errorRetention: "30 days" },
    },
    status: "running",
  })

describe("the shareholding archive page", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = archive()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(shareholdingArchivePage(headers()))
      assert.deepStrictEqual(
        error,
        new Unauthorized({
          redirectTo: "/sign-in?redirect=%2Fadmin%2Fshareholding",
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member, and starts no run for one", () => {
    const {
      layer,
      mails,
      workflow,
      classificationWorkflow,
      investorTypeWorkflow,
      above1Workflow,
    } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const page = yield* Effect.flip(shareholdingArchivePage(headers(cookie)))
      assert.strictEqual(page._tag, "NotFound")
      const run = yield* Effect.flip(runArchiveNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      const parse = yield* Effect.flip(parseClassificationNow(headers(cookie)))
      assert.strictEqual(parse._tag, "NotFound")
      const parseTypes = yield* Effect.flip(
        parseInvestorTypeNow(headers(cookie))
      )
      assert.strictEqual(parseTypes._tag, "NotFound")
      assert.deepStrictEqual(createdIds(workflow), [])
      assert.deepStrictEqual(createdIds(classificationWorkflow), [])
      assert.deepStrictEqual(createdIds(investorTypeWorkflow), [])
      const parseAbove1 = yield* Effect.flip(parseAbove1Now(headers(cookie)))
      assert.strictEqual(parseAbove1._tag, "NotFound")
      assert.deepStrictEqual(createdIds(above1Workflow), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin no run yet, and the next scheduled runs", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T07:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.isUndefined(page.lastRun)
      assert.strictEqual(page.nextRun, "2026-11-14T13:00:00.000Z")
      assert.isUndefined(page.lastClassificationParseRun)
      assert.isUndefined(page.lastInvestorTypeParseRun)
      assert.isUndefined(page.lastAbove1ParseRun)
      // 21:00 WIB, an hour after the evening archive run.
      assert.strictEqual(page.nextParseRun, "2026-11-14T14:00:00.000Z")
      assert.deepStrictEqual(page.recentRuns, [])
      assert.strictEqual(page.totals.reports, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin the recent runs and the archive totals", () => {
    const { layer, mails, bucket, db, indexed } = archive()
    const finished: ArchiveRunResult = {
      ...RUNNING,
      finishedAt: "2026-11-14T13:01:12.000Z",
      outcome: "complete",
      reportsAdded: 1,
    }
    seedLatest(db, finished)
    return Effect.gen(function* () {
      yield* storeReport(
        bucket,
        "above-1",
        "2026-10-31",
        "a".repeat(64),
        "xlsx"
      )
      // Two versions of one report.
      yield* storeReport(
        bucket,
        "above-5",
        "2026-11-13",
        "b".repeat(64),
        "xlsx22"
      )
      yield* storeReport(
        bucket,
        "above-5",
        "2026-11-13",
        "c".repeat(64),
        "xlsx333"
      )
      yield* indexed
      // Stored after the index healed, so not yet counted.
      bucket.objects.set("reports/other/2026-11-12/dd.xlsx", {
        body: "unindexed",
        contentType: "application/octet-stream",
        customMetadata: {},
      })
      yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.deepStrictEqual(page.recentRuns, [
        RunSummary.make({
          id: finished.id,
          trigger: "cron",
          startedAt: "2026-11-14T13:00:00.000Z",
          outcome: "complete",
          reportsAdded: 1,
          newVersions: 0,
        }),
      ])
      assert.deepStrictEqual(page.totals, {
        kinds: [
          { kind: "above-5", reports: 2 },
          { kind: "above-1", reports: 1 },
          { kind: "investor-type", reports: 0 },
          { kind: "investor-classification", reports: 0 },
          { kind: "other", reports: 0 },
        ],
        reports: 3,
        // 17 bytes of files and three 2-byte records.
        bytes: 23,
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "shows the runs a stage held only in R2 on first load, and reads R2 for none on the second",
    () => {
      const { layer, mails, bucket } = archive()
      const finished: ArchiveRunResult = {
        ...RUNNING,
        finishedAt: "2026-11-14T13:01:12.000Z",
        outcome: "complete",
        reportsAdded: 1,
      }
      for (const [key, value] of [
        [`runs/${finished.id}.json`, finished],
        ["runs/latest.json", { id: finished.id }],
      ] as const)
        bucket.objects.set(key, {
          body: JSON.stringify(value),
          contentType: "application/json",
          customMetadata: {},
        })
      const runReads = () =>
        bucket.gets.filter((key) => !key.startsWith("reports/"))
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const first = yield* shareholdingArchivePage(headers(cookie))
        assert.deepStrictEqual(first.lastRun?.result, finished)
        assert.deepStrictEqual(
          first.recentRuns.map(({ id }) => id),
          [finished.id]
        )
        assert.isNotEmpty(runReads())

        bucket.gets.length = 0
        const second = yield* shareholdingArchivePage(headers(cookie))
        assert.deepStrictEqual(second.lastRun, first.lastRun)
        assert.deepStrictEqual(second.recentRuns, first.recentRuns)
        assert.deepStrictEqual(runReads(), [])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("shows each parsed kind's months' parse coverage", () => {
    const { layer, mails, bucket, indexed } = archive()
    const store = (kind: ReportKind, date: string) =>
      storeReport(bucket, kind, date, "a".repeat(64), "xlsx")
    // Twelve cells of 2026, with `state` in `month` (1-based) only.
    const only = (month: number, date: string) => [
      {
        year: 2026,
        months: Array.from({ length: 12 }, (_, i) =>
          i === month - 1
            ? {
                date,
                state: "not-parsed" as const,
                newestSha256: "a".repeat(64),
                parsed: null,
                staleCauses: [],
                failure: null,
              }
            : null
        ),
      },
    ]
    return Effect.gen(function* () {
      yield* store("investor-classification", "2026-10-30")
      yield* store("investor-type", "2026-09-30")
      // Holders above 1% have no parser: not in either parse coverage.
      yield* store("above-1", "2026-08-31")
      yield* indexed
      yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.deepStrictEqual(
        page.classificationParseCoverage,
        only(10, "2026-10-30")
      )
      assert.deepStrictEqual(
        page.investorTypeParseCoverage,
        only(9, "2026-09-30")
      )
    }).pipe(Effect.provide(layer))
  })
})

const finishedParse = (failedOn: string): ParseRunResult => ({
  id: RunId.make("cron-2026-11-14"),
  trigger: "cron",
  startedAt: "2026-11-14T14:00:00.000Z",
  finishedAt: "2026-11-14T14:01:00.000Z",
  outcome: "partial",
  monthsParsed: 0,
  parseFailures: [{ date: failedOn, message: "No sheet" }],
  error: null,
})

describe("the shareholding archive page's ArchiveDb reads", () => {
  it.effect(
    "reads the runs, parse runs, totals and parse coverage in one ArchiveDb batch a load",
    () => {
      const {
        layer,
        mails,
        bucket,
        db,
        indexed,
        workflow,
        classificationWorkflow,
        investorTypeWorkflow,
        above1Workflow,
      } = archive()
      const classification = finishedParse("2026-10-31")
      const investorType = finishedParse("2026-09-30")
      const above1 = finishedParse("2026-08-31")
      seedLatest(db, RUNNING)
      for (const [kind, run] of [
        ["investor-classification", classification],
        ["investor-type", investorType],
        ["above-1", above1],
      ] as const)
        seedRun(db, shareholdingParse(kind), run, { latest: true })
      return Effect.gen(function* () {
        yield* storeReport(
          bucket,
          "investor-classification",
          "2026-10-31",
          "a".repeat(64),
          "xlsx"
        )
        yield* storeReport(
          bucket,
          "investor-type",
          "2026-09-30",
          "b".repeat(64),
          "xlsx"
        )
        yield* indexed
        yield* TestClock.setTime(Date.parse("2026-11-14T15:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const before = db.batches
        const page = yield* shareholdingArchivePage(headers(cookie))
        assert.strictEqual(db.batches - before, 1)
        // Only a row that says running needs its Workflow instance's status.
        assert.deepStrictEqual(workflow.statusReads, [RUNNING.id, RUNNING.id])
        for (const parse of [
          classificationWorkflow,
          investorTypeWorkflow,
          above1Workflow,
        ])
          assert.deepStrictEqual(parse.statusReads, [])
        assert.strictEqual(page.lastRun?.result.id, RUNNING.id)
        assert.deepStrictEqual(
          page.recentRuns.map(({ id }) => id),
          [RUNNING.id]
        )
        assert.deepStrictEqual(
          page.lastClassificationParseRun?.result,
          classification
        )
        assert.deepStrictEqual(
          page.lastInvestorTypeParseRun?.result,
          investorType
        )
        assert.deepStrictEqual(page.lastAbove1ParseRun?.result, above1)
        assert.strictEqual(page.totals.reports, 2)
        assert.deepInclude(page.classificationParseCoverage[0]?.months[9], {
          state: "failed",
          failure: { message: "No sheet", run: classification.id },
        })
        assert.deepInclude(page.investorTypeParseCoverage[0]?.months[8], {
          state: "failed",
          failure: { message: "No sheet", run: investorType.id },
        })
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("logs how long each part of an admin's load took", () => {
    const { layer, mails } = archive()
    const lines: Array<Readonly<Record<string, unknown>>> = []
    const capture = Logger.make(({ message, fiber }) => {
      const [text] = Array.isArray(message) ? message : [message]
      if (text === "Admin page part timed")
        lines.push(fiber.getRef(References.CurrentLogAnnotations))
    })
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* shareholdingArchivePage(headers(cookie))
      assert.sameMembers(
        lines.map(({ part }) => part),
        [
          "authorize",
          "archiveDb",
          "lastRun",
          "recentRuns",
          "totals",
          "lastClassificationParseRun",
          "lastInvestorTypeParseRun",
          "lastAbove1ParseRun",
          "classificationParseCoverage",
          "investorTypeParseCoverage",
          "reads",
        ]
      )
      for (const line of lines) assert.strictEqual(line.page, "shareholding")
    }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([capture])))
  })

  it.effect(
    "reads at most READ_BUDGET of run records in a batch, at 30 days of hourly runs of the largest record",
    () => {
      const { layer, mails, db } = archive()
      const NOW = Date.parse("2026-11-14T14:00:00.000Z")
      const HOUR = 3_600_000
      const padding = "x".repeat(STEP_RESULT_BYTES - 1024)
      for (let hour = 0; hour < 30 * 24; hour++) {
        const startedAt = new Date(NOW - (hour + 1) * HOUR).toISOString()
        seedRun(
          db,
          SHAREHOLDING_ARCHIVE,
          {
            ...RUNNING,
            id: RunId.make(`cron-${startedAt.slice(0, 13)}`),
            startedAt,
            finishedAt: startedAt,
            outcome: "partial",
            notStored: [padding],
          },
          { latest: hour === 0 }
        )
      }
      // 30 days of daily parse runs of each trigger, each failing a month no
      // report is held for at the largest message.
      for (const kind of ["investor-classification", "investor-type"] as const)
        for (const trigger of ["cron", "admin"] as const)
          for (let day = 0; day < 30; day++) {
            const startedAt = new Date(NOW - (day + 1) * 24 * HOUR)
              .toISOString()
              .replace("T14", trigger === "cron" ? "T14" : "T15")
            seedRun(
              db,
              shareholdingParse(kind),
              {
                ...finishedParse("2001-01-31"),
                id: RunId.make(`${trigger}-${startedAt.slice(0, 10)}`),
                trigger,
                startedAt,
                finishedAt: startedAt,
                parseFailures: [{ date: "2001-01-31", message: padding }],
              },
              { latest: trigger === "admin" && day === 0 }
            )
          }
      let mostRead = 0
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW)
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* shareholdingArchivePage(headers(cookie))
        assert.lengthOf(page.recentRuns, 30 * 24)
        assert.isAtMost(mostRead, READ_BUDGET)
      }).pipe(
        Effect.provide(
          Layer.effect(
            ArchiveDb,
            Effect.gen(function* () {
              const inner = yield* ArchiveDb
              return ArchiveDb.of({
                batch: (statements) => {
                  mostRead = Math.max(mostRead, recordBytes(db, statements))
                  // A Worker runs out of memory before it holds the rows.
                  return mostRead > READ_BUDGET
                    ? Effect.die(`${mostRead} bytes of run records`)
                    : inner.batch(statements)
                },
              })
            })
          )
        ),
        Effect.provide(layer)
      )
    },
    120_000
  )
})

// The most bytes of run records one ArchiveDb batch returns: an eighth of
// a Worker's 128 MiB, as each record's row string is parsed and decoded
// beside it.
const READ_BUDGET = 16 * 2 ** 20

// The bytes of run records `statements` return, counted in the database
// without reading them out.
const recordBytes = (
  db: MemoryArchiveDb,
  statements: ReadonlyArray<Statement>
) =>
  statements
    .filter(({ sql }) => /^SELECT .*\brecord\b.* FROM run WHERE/.test(sql))
    .reduce(
      (sum, { sql, params }) =>
        sum +
        Number(
          (
            db.database
              .prepare(
                `SELECT coalesce(sum(length(record)), 0) AS bytes FROM (${sql})`
              )
              .get(...(params as Array<SQLInputValue>)) as { bytes: number }
          ).bytes
        ),
      0
    )

describe("Run now", () => {
  it.effect("starts an admin run named by the time", () => {
    const { layer, mails, workflow, bucket, db } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* TestClock.setTime(1_763_125_032_000)
      assert.deepStrictEqual(yield* runArchiveNow(headers(cookie)), {
        id: "admin-1763125032000",
      })
      assert.deepStrictEqual(createdIds(workflow), ["admin-1763125032000"])
      assert.deepStrictEqual(
        workflow.instances.get("admin-1763125032000")?.options.params,
        { trigger: "admin" }
      )
      // The run is in progress from the moment it is created, before its
      // plan step writes the record: a second Run now is refused at once.
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.strictEqual(page.lastRun?.result.id, "admin-1763125032000")
      assert.isTrue(page.lastRun?.inProgress)
      assert.deepStrictEqual(
        page.recentRuns.map(({ id, outcome }) => ({ id, outcome })),
        [{ id: "admin-1763125032000", outcome: "running" }]
      )
      const again = yield* Effect.flip(runArchiveNow(headers(cookie)))
      assert.strictEqual(again._tag, "Conflict")
      assert.deepStrictEqual(createdIds(workflow), ["admin-1763125032000"])
      assert.strictEqual(
        latestRunId(db, SHAREHOLDING_ARCHIVE),
        "admin-1763125032000"
      )
      // No run is written to R2 any more.
      assert.deepStrictEqual(
        bucket.puts.filter((key) => !key.startsWith("reports/")),
        []
      )
    }).pipe(Effect.provide(layer))
  })

  for (const status of ["running", "waitingForPause", "paused"] as const)
    it.effect(`is refused while the latest run is ${status}`, () => {
      const { layer, mails, workflow, db } = archive()
      seedLatest(db, RUNNING)
      runningInstance(workflow, RUNNING.id)
      const previous = workflow.instances.get(RUNNING.id)
      if (previous !== undefined) previous.status = status
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const error = yield* runArchiveNow(headers(cookie)).pipe(
          Effect.flatMap(({ id }) =>
            Effect.sync(() =>
              assert.fail(
                `expected Run now to be refused, but it started ${id}`
              )
            )
          ),
          Effect.flip
        )
        assert.deepStrictEqual(
          error,
          new Conflict({ message: "A run is in progress." })
        )
        assert.deepStrictEqual(createdIds(workflow), [RUNNING.id])
      }).pipe(Effect.provide(layer))
    })

  it.effect("starts a run once the running one's Workflow errored", () => {
    const { layer, mails, workflow, db } = archive()
    seedLatest(db, RUNNING)
    runningInstance(workflow, RUNNING.id)
    const previous = workflow.instances.get(RUNNING.id)
    if (previous !== undefined) previous.status = "errored"
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* runArchiveNow(headers(cookie))
      assert.strictEqual(createdIds(workflow).length, 2)
    }).pipe(Effect.provide(layer))
  })
})

describe("Parse now on the classification parse run", () => {
  it.effect(
    "starts a classification parse run, then refuses while it runs, apart from Run now",
    () => {
      const { layer, mails, workflow, classificationWorkflow } = archive()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        yield* TestClock.setTime(1_763_125_032_000)
        assert.deepStrictEqual(yield* parseClassificationNow(headers(cookie)), {
          id: "admin-1763125032000",
        })
        assert.deepStrictEqual(
          classificationWorkflow.instances.get("admin-1763125032000")?.options
            .params,
          { trigger: "admin" }
        )
        const page = yield* shareholdingArchivePage(headers(cookie))
        assert.isTrue(page.lastClassificationParseRun?.inProgress)
        assert.deepInclude(page.lastClassificationParseRun?.result, {
          trigger: "admin",
          outcome: "running",
          monthsParsed: 0,
          parseFailures: [],
        })
        // The archive run has a run store of its own.
        assert.isUndefined(page.lastRun)

        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          yield* Effect.flip(parseClassificationNow(headers(cookie))),
          new Conflict({ message: "A parse run is in progress." })
        )
        assert.deepStrictEqual(createdIds(classificationWorkflow), [
          "admin-1763125032000",
        ])
        // An archive run starts while the parse run runs.
        assert.deepStrictEqual(yield* runArchiveNow(headers(cookie)), {
          id: "admin-1763125033000",
        })
        assert.deepStrictEqual(createdIds(workflow), ["admin-1763125033000"])

        // Once the parse run's instance has ended, Parse now starts another.
        const instance = classificationWorkflow.instances.get(
          "admin-1763125032000"
        )
        assert.isDefined(instance)
        instance.status = "complete"
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* parseClassificationNow(headers(cookie)), {
          id: "admin-1763125034000",
        })
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("Parse now on the investor-type parse run", () => {
  it.effect(
    "starts an investor-type parse run, then refuses while it runs, apart from the classification parse run",
    () => {
      const { layer, mails, classificationWorkflow, investorTypeWorkflow } =
        archive()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        yield* TestClock.setTime(1_763_125_032_000)
        assert.deepStrictEqual(yield* parseInvestorTypeNow(headers(cookie)), {
          id: "admin-1763125032000",
        })
        assert.deepStrictEqual(
          investorTypeWorkflow.instances.get("admin-1763125032000")?.options
            .params,
          { trigger: "admin" }
        )
        const page = yield* shareholdingArchivePage(headers(cookie))
        assert.isTrue(page.lastInvestorTypeParseRun?.inProgress)
        assert.deepInclude(page.lastInvestorTypeParseRun?.result, {
          trigger: "admin",
          outcome: "running",
          monthsParsed: 0,
          parseFailures: [],
        })
        // The classification parse run has a run store of its own.
        assert.isUndefined(page.lastClassificationParseRun)

        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          yield* Effect.flip(parseInvestorTypeNow(headers(cookie))),
          new Conflict({ message: "A parse run is in progress." })
        )
        assert.deepStrictEqual(createdIds(investorTypeWorkflow), [
          "admin-1763125032000",
        ])
        // A classification parse run starts while it runs.
        assert.deepStrictEqual(yield* parseClassificationNow(headers(cookie)), {
          id: "admin-1763125033000",
        })
        assert.deepStrictEqual(createdIds(classificationWorkflow), [
          "admin-1763125033000",
        ])
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("Parse now on the above-1% parse run", () => {
  it.effect(
    "starts an above-1% parse run, then refuses while it runs, apart from the investor-type parse run",
    () => {
      const { layer, mails, investorTypeWorkflow, above1Workflow } = archive()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        yield* TestClock.setTime(1_763_125_032_000)
        assert.deepStrictEqual(yield* parseAbove1Now(headers(cookie)), {
          id: "admin-1763125032000",
        })
        assert.deepStrictEqual(
          above1Workflow.instances.get("admin-1763125032000")?.options.params,
          { trigger: "admin" }
        )
        const page = yield* shareholdingArchivePage(headers(cookie))
        assert.isTrue(page.lastAbove1ParseRun?.inProgress)
        assert.deepInclude(page.lastAbove1ParseRun?.result, {
          trigger: "admin",
          outcome: "running",
          monthsParsed: 0,
          parseFailures: [],
        })
        // The investor-type parse run has a run store of its own.
        assert.isUndefined(page.lastInvestorTypeParseRun)

        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          yield* Effect.flip(parseAbove1Now(headers(cookie))),
          new Conflict({ message: "A parse run is in progress." })
        )
        assert.deepStrictEqual(createdIds(above1Workflow), [
          "admin-1763125032000",
        ])
        // An investor-type parse run starts while it runs.
        assert.deepStrictEqual(yield* parseInvestorTypeNow(headers(cookie)), {
          id: "admin-1763125033000",
        })
        assert.deepStrictEqual(createdIds(investorTypeWorkflow), [
          "admin-1763125033000",
        ])
      }).pipe(Effect.provide(layer))
    }
  )
})
