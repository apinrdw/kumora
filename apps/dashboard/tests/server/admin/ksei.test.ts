import { assert, describe, it } from "@effect/vitest"
import { Conflict, Unauthorized } from "@workspace/server"
import { Effect, Layer, Logger, References } from "effect"
import { TestClock } from "effect/testing"

import {
  deepBackfillKsei,
  kseiArchivePage,
  parseKseiNow,
  runKseiNow,
} from "@/server/admin/ksei"
import type { Mail } from "@/server/auth/mailer"
import { ArchiveBucket } from "@/server/archive/bucket"
import { RunId } from "@/server/archive/run"
import { IMPORT_BATCHES, RECORDS_AT_ONCE } from "@/server/archive/run-import"
import { ArchiveWorkflow } from "@/server/archive/workflow"
import { recordKey, reportKey } from "@/server/ksei/keys"
import type { KseiReportKind } from "@/server/ksei/kind"
import { KseiParseWorkflow } from "@/server/ksei/parse-runs"
import { kseiIndex } from "@/server/ksei/report-index"
import type { KseiRunResult } from "@/server/ksei/run-result"
import type { ParseRunResult } from "@/server/holdings/parse-run-result"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"
import { fakeWorkflow, type FakeWorkflow } from "../archive/fake-workflow.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  archiveDbOf,
  KSEI_ARCHIVE,
  KSEI_PARSE,
  runCount,
  seedRun as seedRunRow,
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

const RUNNING: KseiRunResult = {
  id: RunId.make("cron-2026-11-14"),
  trigger: "cron",
  startedAt: "2026-11-14T03:00:00.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  md5Mismatches: [],
  listingFailures: [],
  notStored: [],
  error: null,
  deep: null,
}

const seedRun = (bucket: MemoryBucket, run: KseiRunResult) =>
  seedRunRow(archiveDbOf(bucket), KSEI_ARCHIVE, run)

const seedLatest = (bucket: MemoryBucket, run: KseiRunResult) =>
  seedRunRow(archiveDbOf(bucket), KSEI_ARCHIVE, run, { latest: true })

const seedObject = (bucket: MemoryBucket, key: string, body: string) =>
  bucket.objects.set(key, {
    body,
    contentType: "application/octet-stream",
    customMetadata: {},
  })

// A version of a KSEI report as a run stores it: its file, then its record.
const storeReport = (
  bucket: MemoryBucket,
  kind: KseiReportKind,
  periodEnd: string,
  sha256: string,
  file: string,
  record = "{}"
) =>
  Effect.gen(function* () {
    seedObject(bucket, yield* reportKey(kind, periodEnd, sha256), file)
    seedObject(
      bucket,
      yield* recordKey(kind, periodEnd, sha256, "2026-11-14T03:00:00.000Z", {
        filename: `${sha256}.zip`,
        etag: null,
      }),
      record
    )
  })

const archive = () => {
  const auth = seam()
  const bucket = memoryBucket()
  const db = archiveDbOf(bucket)
  const workflow = fakeWorkflow()
  // The KSEI parse run's own Workflow.
  const parseWorkflow = fakeWorkflow()
  return {
    ...auth,
    bucket,
    workflow,
    parseWorkflow,
    // The report index gains what the bucket holds, as the next KSEI
    // archive run's `plan` would index it.
    indexed: Effect.gen(function* () {
      yield* kseiIndex.heal(yield* (yield* ArchiveBucket).list("reports/"))
    }).pipe(Effect.provide(Layer.merge(bucket.layer, db.layer))),
    layer: Layer.mergeAll(
      auth.layer,
      bucket.layer,
      db.layer,
      memoryHoldingsDb().layer,
      workflow.layer,
      Layer.effect(KseiParseWorkflow, Effect.service(ArchiveWorkflow)).pipe(
        Layer.provide(parseWorkflow.layer)
      )
    ),
  }
}

const createdIds = (workflow: FakeWorkflow) => [...workflow.instances.keys()]

describe("the KSEI archive page", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = archive()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(kseiArchivePage(headers()))
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Fadmin%2Fksei" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member, and starts no run for one", () => {
    const { layer, mails, workflow, parseWorkflow } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const page = yield* Effect.flip(kseiArchivePage(headers(cookie)))
      assert.strictEqual(page._tag, "NotFound")
      const run = yield* Effect.flip(runKseiNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      const deep = yield* Effect.flip(deepBackfillKsei(headers(cookie)))
      assert.strictEqual(deep._tag, "NotFound")
      const parse = yield* Effect.flip(parseKseiNow(headers(cookie)))
      assert.strictEqual(parse._tag, "NotFound")
      assert.deepStrictEqual(createdIds(workflow), [])
      assert.deepStrictEqual(createdIds(parseWorkflow), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin no run yet, and the next run at 10:00 WIB", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T04:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* kseiArchivePage(headers(cookie))
      assert.isUndefined(page.lastRun)
      assert.strictEqual(page.nextRun, "2026-11-15T03:00:00.000Z")
      assert.isUndefined(page.lastParseRun)
      // An hour after the KSEI archive run.
      assert.strictEqual(page.nextParseRun, "2026-11-15T04:00:00.000Z")
      assert.deepStrictEqual(page.recentRuns, [])
      assert.strictEqual(page.totals.reports, 0)
      assert.isUndefined(page.lastDeepRun)
    }).pipe(Effect.provide(layer))
  })

  it.effect("totals each kind's reports, versions and size", () => {
    const { layer, mails, bucket, indexed } = archive()
    const kind = "securities-statistics"
    return Effect.gen(function* () {
      // Two versions of October, one of September, each with its record.
      yield* storeReport(bucket, kind, "2026-10-30", "a".repeat(64), "zip1")
      yield* storeReport(bucket, kind, "2026-10-30", "b".repeat(64), "zip22")
      yield* storeReport(bucket, kind, "2026-09-30", "c".repeat(64), "zip333")
      yield* indexed
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const { totals } = yield* kseiArchivePage(headers(cookie))
      assert.deepStrictEqual(totals, {
        kinds: [
          {
            kind: "securities-statistics",
            reports: 2,
            versions: 3,
            bytes: 21,
          },
          { kind: "securities-holdings", reports: 0, versions: 0, bytes: 0 },
        ],
        reports: 2,
        bytes: 21,
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows the Securities holdings months' parse coverage", () => {
    const { layer, mails, bucket, indexed } = archive()
    return Effect.gen(function* () {
      yield* storeReport(
        bucket,
        "securities-holdings",
        "2026-10-30",
        "a".repeat(64),
        "zip"
      )
      // A Securities statistics report has no parser: not in the parse
      // coverage.
      yield* storeReport(
        bucket,
        "securities-statistics",
        "2025-01-31",
        "b".repeat(64),
        "zip"
      )
      yield* indexed
      yield* TestClock.setTime(Date.parse("2026-11-14T04:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const { parseCoverage } = yield* kseiArchivePage(headers(cookie))
      assert.deepStrictEqual(parseCoverage, [
        {
          year: 2026,
          months: [
            ...Array.from({ length: 9 }, () => null),
            {
              date: "2026-10-30",
              state: "not-parsed",
              newestSha256: "a".repeat(64),
              parsed: null,
              staleCauses: [],
              failure: null,
            },
            null,
            null,
          ],
        },
      ])
    }).pipe(Effect.provide(layer))
  })
})

describe("the KSEI archive page's ArchiveDb reads", () => {
  it.effect(
    "reads the runs, deep run, parse runs, totals and coverage in one ArchiveDb batch a load",
    () => {
      const { layer, mails, bucket, indexed, workflow, parseWorkflow } =
        archive()
      const db = archiveDbOf(bucket)
      const deep: KseiRunResult = {
        ...RUNNING,
        id: RunId.make("deep-1763000000000"),
        trigger: "deep",
        startedAt: "2026-11-13T02:13:20.000Z",
        finishedAt: "2026-11-13T03:00:00.000Z",
        outcome: "complete",
        deep: {
          foundFromSeed: [],
          foundByProbing: [],
          monthsNotFound: {
            "securities-statistics": [],
            "securities-holdings": ["2026-09"],
          },
          probeFailures: [],
        },
      }
      const parsed: ParseRunResult = {
        id: RunId.make("cron-2026-11-14"),
        trigger: "cron",
        startedAt: "2026-11-14T04:00:00.000Z",
        finishedAt: "2026-11-14T04:01:00.000Z",
        outcome: "partial",
        monthsParsed: 0,
        parseFailures: [{ date: "2026-10-30", message: "No sheet" }],
        error: null,
      }
      return Effect.gen(function* () {
        seedRunRow(db, KSEI_ARCHIVE, deep)
        seedLatest(bucket, RUNNING)
        seedRunRow(db, KSEI_PARSE, parsed, { latest: true })
        yield* storeReport(
          bucket,
          "securities-holdings",
          "2026-10-30",
          "a".repeat(64),
          "zip"
        )
        yield* indexed
        yield* TestClock.setTime(Date.parse("2026-11-14T05:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const before = db.batches
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(db.batches - before, 1)
        // Only a row that says running needs its Workflow instance's status.
        assert.deepStrictEqual(workflow.statusReads, [RUNNING.id, RUNNING.id])
        assert.deepStrictEqual(parseWorkflow.statusReads, [])
        assert.strictEqual(page.lastRun?.result.id, RUNNING.id)
        assert.deepStrictEqual(
          page.recentRuns.map(({ id }) => id),
          [RUNNING.id, deep.id]
        )
        assert.deepStrictEqual(page.lastDeepRun, {
          id: deep.id,
          finishedAt: deep.finishedAt,
        })
        assert.deepStrictEqual(page.lastParseRun?.result, parsed)
        assert.strictEqual(page.totals.reports, 1)
        assert.deepInclude(page.parseCoverage[0]?.months[9], {
          state: "failed",
          failure: { message: "No sheet", run: parsed.id },
        })
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("the KSEI archive page's deep run", () => {
  it.effect(
    "finds the latest deep run with finds behind more deep runs without them than one read takes",
    () => {
      const { layer, mails, bucket } = archive()
      const db = archiveDbOf(bucket)
      const deepAt = (epochMs: number, finds: boolean): KseiRunResult => ({
        ...RUNNING,
        id: RunId.make(`deep-${epochMs}`),
        trigger: "deep",
        startedAt: new Date(epochMs).toISOString(),
        finishedAt: new Date(epochMs + 60_000).toISOString(),
        outcome: finds ? "complete" : "failed",
        deep: finds
          ? {
              foundFromSeed: [],
              foundByProbing: [],
              monthsNotFound: {
                "securities-statistics": [],
                "securities-holdings": [],
              },
              probeFailures: [],
            }
          : null,
      })
      const found = deepAt(1_750_000_000_000, true)
      return Effect.gen(function* () {
        seedRunRow(db, KSEI_ARCHIVE, found)
        // Fifty later deep runs that ended without finds.
        for (let day = 1; day <= 50; day++)
          seedRunRow(
            db,
            KSEI_ARCHIVE,
            deepAt(1_750_000_000_000 + day * 86_400_000, false)
          )
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.deepStrictEqual(page.lastDeepRun, {
          id: found.id,
          finishedAt: found.finishedAt,
        })
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("the KSEI archive page's timing", () => {
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
      yield* kseiArchivePage(headers(cookie))
      assert.sameMembers(
        lines.map(({ part }) => part),
        [
          "authorize",
          "archiveDb",
          "lastRun",
          "recentRuns",
          "reportIndex",
          "lastDeepRun",
          "lastParseRun",
          "parseCoverage",
          "reads",
        ]
      )
      for (const line of lines) {
        assert.strictEqual(line.page, "ksei")
        assert.isNumber(line.ms)
      }
    }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([capture])))
  })
})

describe("KSEI's Run now", () => {
  it.effect("starts an admin run, then refuses while it runs", () => {
    const { layer, mails, workflow } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* TestClock.setTime(1_763_125_032_000)
      assert.deepStrictEqual(yield* runKseiNow(headers(cookie)), {
        id: "admin-1763125032000",
      })
      assert.deepStrictEqual(
        workflow.instances.get("admin-1763125032000")?.options.params,
        { trigger: "admin" }
      )
      const page = yield* kseiArchivePage(headers(cookie))
      assert.isTrue(page.lastRun?.inProgress)
      const again = yield* Effect.flip(runKseiNow(headers(cookie)))
      assert.deepStrictEqual(
        again,
        new Conflict({ message: "A run is in progress." })
      )
      assert.deepStrictEqual(createdIds(workflow), ["admin-1763125032000"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("is refused while the seeded latest run is running", () => {
    const { layer, mails, workflow, bucket } = archive()
    seedLatest(bucket, RUNNING)
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(RUNNING.startedAt) + 60_000)
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const error = yield* Effect.flip(runKseiNow(headers(cookie)))
      assert.strictEqual(error._tag, "Conflict")
      assert.deepStrictEqual(createdIds(workflow), [])
    }).pipe(Effect.provide(layer))
  })
})

describe("KSEI's Parse now", () => {
  it.effect(
    "starts a parse run, then refuses while it runs, apart from Run now",
    () => {
      const { layer, mails, workflow, parseWorkflow } = archive()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        yield* TestClock.setTime(1_763_125_032_000)
        assert.deepStrictEqual(yield* parseKseiNow(headers(cookie)), {
          id: "admin-1763125032000",
        })
        assert.deepStrictEqual(
          parseWorkflow.instances.get("admin-1763125032000")?.options.params,
          { trigger: "admin" }
        )
        const page = yield* kseiArchivePage(headers(cookie))
        assert.isTrue(page.lastParseRun?.inProgress)
        assert.deepInclude(page.lastParseRun?.result, {
          trigger: "admin",
          outcome: "running",
          monthsParsed: 0,
          parseFailures: [],
        })
        // The archive run has a run store of its own.
        assert.isUndefined(page.lastRun)

        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          yield* Effect.flip(parseKseiNow(headers(cookie))),
          new Conflict({ message: "A parse run is in progress." })
        )
        assert.deepStrictEqual(createdIds(parseWorkflow), [
          "admin-1763125032000",
        ])
        // An archive run starts while the parse run runs.
        assert.deepStrictEqual(yield* runKseiNow(headers(cookie)), {
          id: "admin-1763125033000",
        })
        assert.deepStrictEqual(createdIds(workflow), ["admin-1763125033000"])

        // Once the parse run's instance has ended, Parse now starts another.
        const instance = parseWorkflow.instances.get("admin-1763125032000")
        assert.isDefined(instance)
        instance.status = "complete"
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* parseKseiNow(headers(cookie)), {
          id: "admin-1763125034000",
        })
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("KSEI's Deep backfill", () => {
  it.effect(
    "starts a deep run, then refuses either start while it runs",
    () => {
      const { layer, mails, workflow } = archive()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        yield* TestClock.setTime(1_763_125_032_000)
        assert.deepStrictEqual(yield* deepBackfillKsei(headers(cookie)), {
          id: "deep-1763125032000",
        })
        assert.deepStrictEqual(
          workflow.instances.get("deep-1763125032000")?.options.params,
          { trigger: "deep" }
        )
        const conflict = new Conflict({ message: "A run is in progress." })
        assert.deepStrictEqual(
          yield* Effect.flip(deepBackfillKsei(headers(cookie))),
          conflict
        )
        assert.deepStrictEqual(
          yield* Effect.flip(runKseiNow(headers(cookie))),
          conflict
        )
        assert.deepStrictEqual(createdIds(workflow), ["deep-1763125032000"])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "gives the page the latest ended deep run's months not found, however old",
    () => {
      const { layer, mails, bucket } = archive()
      const ended = (id: string, startedAt: string, notFound: string) => ({
        ...RUNNING,
        id: RunId.make(id),
        trigger: "deep" as const,
        startedAt,
        finishedAt: startedAt,
        outcome: "complete" as const,
        deep: {
          foundFromSeed: [],
          foundByProbing: [],
          monthsNotFound: {
            "securities-statistics": [notFound],
            "securities-holdings": [],
          },
          probeFailures: [],
        },
      })
      seedRun(
        bucket,
        ended("deep-1700000000000", "2023-11-14T22:13:20.000Z", "2019-05")
      )
      seedRun(
        bucket,
        ended("deep-1750000000000", "2025-06-15T15:06:40.000Z", "2020-07")
      )
      // Still running: no finds yet.
      seedRun(bucket, {
        ...RUNNING,
        id: RunId.make("deep-1763125032000"),
        trigger: "deep",
        startedAt: "2026-11-14T13:57:12.000Z",
      })
      seedRun(bucket, {
        ...RUNNING,
        finishedAt: RUNNING.startedAt,
        outcome: "complete",
      })
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.deepStrictEqual(page.lastDeepRun, {
          id: RunId.make("deep-1750000000000"),
          finishedAt: "2025-06-15T15:06:40.000Z",
        })
        const statistics = page.coverage[0]
        assert.strictEqual(statistics?.kind, "securities-statistics")
        // The older deep run's month is no longer known as not found.
        assert.strictEqual(monthOf(statistics, 2019, 5), "never-looked-for")
        assert.strictEqual(monthOf(statistics, 2020, 7), "not-found")
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("the KSEI archive page after the cutover", () => {
  it.effect(
    "shows the last run, the recent runs and a deep run older than 30 days a stage held only in R2",
    () => {
      const { layer, mails, bucket } = archive()
      const deep: KseiRunResult = {
        ...RUNNING,
        id: RunId.make("deep-1750000000000"),
        trigger: "deep",
        startedAt: "2025-06-15T15:06:40.000Z",
        finishedAt: "2025-06-15T16:00:00.000Z",
        outcome: "complete",
        deep: {
          foundFromSeed: [],
          foundByProbing: [],
          monthsNotFound: {
            "securities-statistics": ["2020-07"],
            "securities-holdings": [],
          },
          probeFailures: [],
        },
      }
      const last: KseiRunResult = {
        ...RUNNING,
        finishedAt: "2026-11-14T03:05:00.000Z",
        outcome: "complete",
      }
      for (const [key, value] of [
        [`runs/${deep.id}.json`, deep],
        [`runs/${last.id}.json`, last],
        ["runs/latest.json", { id: last.id }],
      ] as const)
        bucket.objects.set(key, {
          body: JSON.stringify(value),
          contentType: "application/json",
          customMetadata: {},
        })
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        for (const load of [1, 2]) {
          bucket.gets.length = 0
          const page = yield* kseiArchivePage(headers(cookie))
          assert.deepStrictEqual(page.lastRun?.result, last, `load ${load}`)
          assert.deepStrictEqual(
            page.recentRuns.map(({ id }) => id),
            [last.id]
          )
          assert.deepStrictEqual(page.lastDeepRun, {
            id: deep.id,
            finishedAt: deep.finishedAt,
          })
        }
        // The second load read no run from R2.
        assert.deepStrictEqual(
          bucket.gets.filter((key) => key.includes("runs/")),
          []
        )
      }).pipe(Effect.provide(layer))
    }
  )
})

// A stage whose KSEI runs were only in R2 when ArchiveDb began to hold them.
const inR2 = (
  bucket: MemoryBucket,
  run: KseiRunResult | ParseRunResult,
  prefix = "runs/"
) => putJson(bucket, `${prefix}${run.id}.json`, run)

const putJson = (bucket: MemoryBucket, key: string, value: unknown) =>
  bucket.objects.set(key, {
    body: JSON.stringify(value),
    contentType: "application/json",
    customMetadata: {},
  })

// A deep run that started at `startedAt` and ended with its finds.
const deepAt = (startedAt: string): KseiRunResult => ({
  ...RUNNING,
  id: RunId.make(`deep-${Date.parse(startedAt)}`),
  trigger: "deep",
  startedAt,
  finishedAt: startedAt,
  outcome: "complete",
  deep: {
    foundFromSeed: [],
    foundByProbing: [],
    monthsNotFound: {
      "securities-statistics": [],
      "securities-holdings": [],
    },
    probeFailures: [],
  },
})

// A Run now that started and ended at `at`.
const adminAt = (at: number): KseiRunResult => ({
  ...RUNNING,
  id: RunId.make(`admin-${at}`),
  trigger: "admin",
  startedAt: new Date(at).toISOString(),
  finishedAt: new Date(at).toISOString(),
  outcome: "complete",
})

// Run nows a minute apart from `from`, one fewer than a load's import reads.
const fillALoad = (bucket: MemoryBucket, from: string) => {
  for (let run = 1; run < IMPORT_BATCHES * RECORDS_AT_ONCE; run++)
    inR2(bucket, adminAt(Date.parse(from) + run * 60_000))
}

describe("the KSEI cutover import's deep run", () => {
  it.effect(
    "stops at a deep run of the past 30 days, reading no older one",
    () => {
      const { layer, mails, bucket } = archive()
      const older = deepAt("2025-06-15T15:06:40.000Z")
      const recent = deepAt("2026-11-10T15:06:40.000Z")
      for (const run of [older, recent]) inR2(bucket, run)
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(page.lastDeepRun?.id, recent.id)
        assert.notInclude(bucket.gets, `runs/${older.id}.json`)
        assert.strictEqual(runCount(archiveDbOf(bucket), KSEI_ARCHIVE), 1)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "keeps the deep run it found when the import spans loads, reading no older one, and answers a Conflict until then",
    () => {
      const { layer, mails, bucket } = archive()
      const older = deepAt("2025-06-15T15:06:40.000Z")
      const recent = deepAt("2026-11-10T15:06:40.000Z")
      inR2(bucket, older)
      inR2(bucket, recent)
      // With the deep run they fill the first load's import, so the
      // pointer's run waits for the second load.
      fillALoad(bucket, "2026-11-01T00:00:00.000Z")
      const pointed: KseiRunResult = {
        ...RUNNING,
        id: RunId.make("cron-2026-09-01"),
        trigger: "cron",
        startedAt: "2026-09-01T03:00:00.000Z",
        finishedAt: "2026-09-01T03:05:00.000Z",
        outcome: "complete",
      }
      inR2(bucket, pointed)
      putJson(bucket, "runs/latest.json", { id: pointed.id })
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const importing = yield* Effect.flip(kseiArchivePage(headers(cookie)))
        assert.instanceOf(importing, Conflict)
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(page.lastRun?.result.id, pointed.id)
        assert.strictEqual(page.lastDeepRun?.id, recent.id)
        assert.notInclude(bucket.gets, `runs/${older.id}.json`)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "keeps a deep run named at the cutoff that its Workflow started just before",
    () => {
      const { layer, mails, bucket } = archive()
      // The load at 14:30 puts the cutoff at 14:30, 30 days before. A
      // start names its run by the Worker's clock, and the run's Workflow
      // dates its start by its own, here a quarter second behind.
      const cutoff = Date.parse("2026-10-15T14:30:00.000Z")
      const atCutoff: KseiRunResult = {
        ...deepAt(new Date(cutoff - 250).toISOString()),
        id: RunId.make(`deep-${cutoff}`),
      }
      inR2(bucket, deepAt("2025-06-15T15:06:40.000Z"))
      inR2(bucket, atCutoff)
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:30:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(page.lastDeepRun?.id, atCutoff.id)
        assert.deepStrictEqual(page.recentRuns, [])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "finds the newest deep run when the cutoff passes it between two loads of one import",
    () => {
      const { layer, mails, bucket } = archive()
      // Both started just inside the first load's 30 days. The Run nows
      // fill that load's import, which reads the first of the two at most.
      const first = deepAt("2026-10-15T14:01:00.000Z")
      const newest = deepAt("2026-10-15T14:02:00.000Z")
      inR2(bucket, first)
      inR2(bucket, newest)
      fillALoad(bucket, "2026-11-01T00:00:00.000Z")
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const importing = yield* Effect.flip(kseiArchivePage(headers(cookie)))
        assert.instanceOf(importing, Conflict)
        // Both deep runs are older than 30 days by the second load.
        yield* TestClock.adjust("5 minutes")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(page.lastDeepRun?.id, newest.id)
      }).pipe(Effect.provide(layer))
    }
  )
  it.effect(
    "shows a last run that its trigger's reader passes over, and the older run the reader takes",
    () => {
      const { layer, mails, bucket } = archive()
      // The pointer names a deep run that failed before its finds, older
      // than 30 days: only the latest scan keeps it.
      const pointed: KseiRunResult = {
        ...deepAt("2026-09-01T03:00:00.000Z"),
        outcome: "failed",
        error: "KSEI answered 503",
        deep: null,
      }
      const withFinds = deepAt("2025-06-15T15:06:40.000Z")
      inR2(bucket, pointed)
      inR2(bucket, withFinds)
      putJson(bucket, "runs/latest.json", { id: pointed.id })
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.deepStrictEqual(page.lastRun?.result, pointed)
        assert.strictEqual(page.lastDeepRun?.id, withFinds.id)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "resumes a reader's scan on the next load, reading no record twice",
    () => {
      const { layer, mails, bucket } = archive()
      // More deep runs without finds, all older than 30 days, than one
      // load's import reads, and behind them the one with finds.
      const withFinds = deepAt("2025-06-15T15:06:40.000Z")
      inR2(bucket, withFinds)
      const without = IMPORT_BATCHES * RECORDS_AT_ONCE + 50
      for (let run = 0; run < without; run++)
        inR2(bucket, {
          ...deepAt(
            new Date(
              Date.parse("2026-01-01T00:00:00.000Z") + run * 3_600_000
            ).toISOString()
          ),
          deep: null,
        })
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const importing = yield* Effect.flip(kseiArchivePage(headers(cookie)))
        assert.instanceOf(importing, Conflict)
        const page = yield* kseiArchivePage(headers(cookie))
        assert.strictEqual(page.lastDeepRun?.id, withFinds.id)
        const reads = bucket.gets.filter((key) => key.startsWith("runs/deep-"))
        assert.strictEqual(reads.length, without + 1)
        assert.strictEqual(new Set(reads).size, without + 1)
        assert.strictEqual(runCount(archiveDbOf(bucket), KSEI_ARCHIVE), 1)
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("the KSEI cutover import's parse runs", () => {
  it.effect(
    "shows a last parse run that started on the cutoff's day, before the past 30 days, and its parse failures",
    () => {
      const { layer, mails, bucket, indexed } = archive()
      // The load at 14:30 puts the cutoff at 14:30, 30 days before. The
      // daily cron's run of that day started at 04:00.
      const atCutoff: ParseRunResult = {
        id: RunId.make("cron-2026-10-15"),
        trigger: "cron",
        startedAt: "2026-10-15T04:00:00.000Z",
        finishedAt: "2026-10-15T04:01:00.000Z",
        outcome: "partial",
        monthsParsed: 0,
        parseFailures: [{ date: "2026-09-30", message: "No sheet" }],
        error: null,
      }
      inR2(bucket, atCutoff, "parse-runs/")
      putJson(bucket, "parse-runs/latest.json", { id: atCutoff.id })
      return Effect.gen(function* () {
        yield* storeReport(
          bucket,
          "securities-holdings",
          "2026-09-30",
          "a".repeat(64),
          "zip"
        )
        yield* indexed
        yield* TestClock.setTime(Date.parse("2026-11-14T14:30:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const page = yield* kseiArchivePage(headers(cookie))
        assert.deepStrictEqual(page.lastParseRun?.result, atCutoff)
        assert.deepInclude(page.parseCoverage[0]?.months[8], {
          state: "failed",
          failure: { message: "No sheet", run: atCutoff.id },
        })
      }).pipe(Effect.provide(layer))
    }
  )
})

type Coverage = Effect.Success<
  ReturnType<typeof kseiArchivePage>
>["coverage"][number]

const monthOf = (coverage: Coverage | undefined, year: number, month: number) =>
  coverage?.years.find((row) => row.year === year)?.months[month - 1]

const NEVER = "never-looked-for" as const

describe("the KSEI coverage grid", () => {
  const deepRun = (monthsNotFound: {
    "securities-statistics": ReadonlyArray<string>
    "securities-holdings": ReadonlyArray<string>
  }): KseiRunResult => ({
    ...RUNNING,
    id: RunId.make("deep-1763089200000"),
    trigger: "deep",
    finishedAt: RUNNING.startedAt,
    outcome: "complete",
    deep: {
      foundFromSeed: [],
      foundByProbing: [],
      monthsNotFound,
      probeFailures: [],
    },
  })
  const record = (
    bucket: MemoryBucket,
    kind: KseiReportKind,
    periodEnd: string
  ) => storeReport(bucket, kind, periodEnd, "a".repeat(64), "z")

  it.effect(
    "shows each month held, not found by the latest deep run, or never looked for",
    () => {
      const { layer, mails, bucket, indexed } = archive()
      seedRun(
        bucket,
        deepRun({
          "securities-statistics": ["2018-12"],
          "securities-holdings": ["2019-03", "2023-12"],
        })
      )
      return Effect.gen(function* () {
        yield* record(bucket, "securities-statistics", "2018-11-30")
        yield* record(bucket, "securities-statistics", "2026-10-30")
        // Stored after the deep run looked: held wins.
        yield* record(bucket, "securities-holdings", "2019-03-29")
        // A zip without its record is not a complete version.
        seedObject(
          bucket,
          yield* reportKey("securities-holdings", "2019-04-30", "b".repeat(64)),
          "z"
        )
        // Before the archive's first month: not shown, though held.
        yield* record(bucket, "securities-holdings", "2018-10-31")
        yield* indexed
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const { coverage } = yield* kseiArchivePage(headers(cookie))
        assert.deepStrictEqual(
          coverage.map(({ kind }) => kind),
          ["securities-statistics", "securities-holdings"]
        )
        const [statistics, holdings] = coverage
        assert.deepStrictEqual(
          statistics?.years.map(({ year }) => year),
          Array.from({ length: 9 }, (_, i) => 2018 + i)
        )
        // 2018 starts at November, the archive's first month.
        assert.deepStrictEqual(statistics?.years[0]?.months, [
          ...Array.from({ length: 10 }, () => null),
          "held",
          "not-found",
        ])
        // 2026 runs to November, the current month.
        assert.deepStrictEqual(statistics?.years.at(-1)?.months, [
          ...Array.from({ length: 9 }, () => NEVER),
          "held",
          NEVER,
        ])
        assert.deepStrictEqual(holdings?.years[0]?.months, [
          ...Array.from({ length: 10 }, () => null),
          NEVER,
          NEVER,
        ])
        assert.deepStrictEqual(holdings?.years[1]?.months, [
          NEVER,
          NEVER,
          "held",
          NEVER,
          ...Array.from({ length: 8 }, () => NEVER),
        ])
        assert.strictEqual(monthOf(holdings, 2023, 12), "not-found")
        assert.strictEqual(monthOf(statistics, 2023, 12), NEVER)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "shows every month without a KSEI report as never looked for",
    () => {
      const { layer, mails, bucket, indexed } = archive()
      return Effect.gen(function* () {
        yield* record(bucket, "securities-holdings", "2020-06-30")
        yield* indexed
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const { coverage, lastDeepRun } = yield* kseiArchivePage(
          headers(cookie)
        )
        assert.isUndefined(lastDeepRun)
        const states = coverage.flatMap(({ years }) =>
          years.flatMap(({ months }) => months)
        )
        // All of 2018, its first ten null, to November 2026.
        assert.strictEqual(states.length, 2 * (12 + 7 * 12 + 11))
        assert.deepStrictEqual(
          states.filter((state) => state !== NEVER && state !== null),
          ["held"]
        )
        assert.strictEqual(monthOf(coverage[1], 2020, 6), "held")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("ends at the current month in WIB", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      // Nov 30, 18:00 UTC is Dec 1, 01:00 WIB.
      yield* TestClock.setTime(Date.parse("2026-11-30T18:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const { coverage } = yield* kseiArchivePage(headers(cookie))
      assert.strictEqual(coverage[0]?.years.at(-1)?.months.length, 12)
    }).pipe(Effect.provide(layer))
  })
})
