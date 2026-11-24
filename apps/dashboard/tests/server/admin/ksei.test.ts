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
import { ArchiveWorkflow } from "@/server/archive/workflow"
import { recordKey, reportKey } from "@/server/ksei/keys"
import type { KseiReportKind } from "@/server/ksei/kind"
import { KseiParseWorkflow } from "@/server/ksei/parse-runs"
import { healKseiIndex } from "@/server/ksei/report-index"
import type { KseiRunResult } from "@/server/ksei/run-result"

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
      yield* healKseiIndex(yield* (yield* ArchiveBucket).list("reports/"))
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
    const { layer, mails, bucket } = archive()
    seedObject(
      bucket,
      `reports/securities-holdings/2026-10-30/${"a".repeat(64)}.2026-11-14T030000.000Z.0123456789abcdef.json`,
      "{}"
    )
    // A Securities statistics report has no parser: not in the parse coverage.
    seedObject(
      bucket,
      `reports/securities-statistics/2025-01-31/${"b".repeat(64)}.2026-11-14T030000.000Z.0123456789abcdef.json`,
      "{}"
    )
    return Effect.gen(function* () {
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
