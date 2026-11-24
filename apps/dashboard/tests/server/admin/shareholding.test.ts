import { assert, describe, it } from "@effect/vitest"
import { Conflict, Unauthorized } from "@workspace/server"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import {
  parseAbove1Now,
  parseClassificationNow,
  parseInvestorTypeNow,
  runArchiveNow,
  shareholdingArchivePage,
} from "@/server/admin/shareholding"
import type { Mail } from "@/server/auth/mailer"
import { RunId } from "@/server/archive/run"
import { ArchiveWorkflow } from "@/server/archive/workflow"
import { Above1ParseWorkflow } from "@/server/shareholding/above-1-parse"
import { ClassificationParseWorkflow } from "@/server/shareholding/classification-parse"
import { InvestorTypeParseWorkflow } from "@/server/shareholding/investor-type-parse"
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
import { memoryBucket } from "../archive/memory-bucket.ts"
import { latestRunId, SHAREHOLDING_ARCHIVE, seedRun } from "../archive/runs.ts"
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
    const { layer, mails, bucket, db } = archive()
    const finished: ArchiveRunResult = {
      ...RUNNING,
      finishedAt: "2026-11-14T13:01:12.000Z",
      outcome: "complete",
      reportsAdded: 1,
    }
    seedLatest(db, finished)
    bucket.objects.set("reports/above-1/2026-10-31/aa.xlsx", {
      body: "xlsx",
      contentType: "application/octet-stream",
      customMetadata: {},
    })
    return Effect.gen(function* () {
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
      assert.deepStrictEqual(
        page.totals.kinds.find(({ kind }) => kind === "above-1"),
        { kind: "above-1", reports: 1 }
      )
      assert.strictEqual(page.totals.bytes, 4)
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
    const { layer, mails, bucket } = archive()
    const record = (kind: string, date: string) =>
      bucket.objects.set(
        `reports/${kind}/${date}/${"a".repeat(64)}.2026-11-14T130000.000Z.0123456789abcdef.json`,
        { body: "{}", contentType: "application/json", customMetadata: {} }
      )
    record("investor-classification", "2026-10-30")
    record("investor-type", "2026-09-30")
    // Holders above 1% have no parser: not in either parse coverage.
    record("above-1", "2026-08-31")
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
