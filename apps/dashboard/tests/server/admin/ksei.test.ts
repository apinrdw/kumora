import { assert, describe, it } from "@effect/vitest"
import { Conflict, Unauthorized } from "@workspace/server"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import {
  deepBackfillKsei,
  kseiArchivePage,
  runKseiNow,
} from "@/server/admin/ksei"
import type { Mail } from "@/server/auth/mailer"
import { RunId } from "@/server/archive/run"
import { KseiRunMetadata, type KseiRunResult } from "@/server/ksei/run-result"

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
  bucket.objects.set(`runs/${run.id}.json`, {
    body: JSON.stringify(run),
    contentType: "application/json",
    customMetadata: Schema.encodeSync(KseiRunMetadata)({ run }),
  })

const seedLatest = (bucket: MemoryBucket, run: KseiRunResult) => {
  seedRun(bucket, run)
  bucket.objects.set("runs/latest.json", {
    body: JSON.stringify({ id: run.id }),
    contentType: "application/json",
    customMetadata: {},
  })
}

const seedObject = (bucket: MemoryBucket, key: string, body: string) =>
  bucket.objects.set(key, {
    body,
    contentType: "application/octet-stream",
    customMetadata: {},
  })

const archive = () => {
  const auth = seam()
  const bucket = memoryBucket()
  const workflow = fakeWorkflow()
  return {
    ...auth,
    bucket,
    workflow,
    layer: Layer.mergeAll(auth.layer, bucket.layer, workflow.layer),
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
    const { layer, mails, workflow } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const page = yield* Effect.flip(kseiArchivePage(headers(cookie)))
      assert.strictEqual(page._tag, "NotFound")
      const run = yield* Effect.flip(runKseiNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      const deep = yield* Effect.flip(deepBackfillKsei(headers(cookie)))
      assert.strictEqual(deep._tag, "NotFound")
      assert.deepStrictEqual(createdIds(workflow), [])
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
      assert.deepStrictEqual(page.recentRuns, [])
      assert.strictEqual(page.totals.reports, 0)
      assert.isUndefined(page.lastDeepRun)
    }).pipe(Effect.provide(layer))
  })

  it.effect("totals each kind's reports, versions and size", () => {
    const { layer, mails, bucket } = archive()
    const prefix = "reports/securities-statistics/"
    // Two versions of October, one of September, each with its record.
    seedObject(bucket, `${prefix}2026-10-30/aa.zip`, "zip1")
    seedObject(bucket, `${prefix}2026-10-30/aa.t.x.json`, "{}")
    seedObject(bucket, `${prefix}2026-10-30/bb.zip`, "zip22")
    seedObject(bucket, `${prefix}2026-10-30/bb.t.x.json`, "{}")
    seedObject(bucket, `${prefix}2026-09-30/cc.zip`, "zip333")
    seedObject(bucket, `${prefix}2026-09-30/cc.t.x.json`, "{}")
    return Effect.gen(function* () {
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
        ended("deep-1700000000000", "2023-11-14T22:13:20.000Z", "2008-05")
      )
      seedRun(
        bucket,
        ended("deep-1750000000000", "2025-06-15T15:06:40.000Z", "2009-07")
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
        assert.strictEqual(monthOf(statistics, 2008, 5), "never-looked-for")
        assert.strictEqual(monthOf(statistics, 2009, 7), "not-found")
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
  const record = (bucket: MemoryBucket, kind: string, periodEnd: string) =>
    seedObject(bucket, `reports/${kind}/${periodEnd}/aa.t.x.json`, "{}")

  it.effect(
    "shows each month held, not found by the latest deep run, or never looked for",
    () => {
      const { layer, mails, bucket } = archive()
      record(bucket, "securities-statistics", "2008-01-31")
      record(bucket, "securities-statistics", "2026-10-30")
      // Stored after the deep run looked: held wins.
      record(bucket, "securities-holdings", "2008-03-31")
      // A zip without its record is not a complete version.
      seedObject(bucket, "reports/securities-holdings/2008-04-30/bb.zip", "z")
      seedRun(
        bucket,
        deepRun({
          "securities-statistics": ["2008-02"],
          "securities-holdings": ["2008-03", "2023-12"],
        })
      )
      return Effect.gen(function* () {
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
          Array.from({ length: 19 }, (_, i) => 2008 + i)
        )
        assert.deepStrictEqual(statistics?.years[0]?.months, [
          "held",
          "not-found",
          ...Array.from({ length: 10 }, () => NEVER),
        ])
        // 2026 runs to November, the current month.
        assert.deepStrictEqual(statistics?.years.at(-1)?.months, [
          ...Array.from({ length: 9 }, () => NEVER),
          "held",
          NEVER,
        ])
        assert.deepStrictEqual(holdings?.years[0]?.months, [
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
      const { layer, mails, bucket } = archive()
      record(bucket, "securities-holdings", "2015-06-30")
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const { coverage, lastDeepRun } = yield* kseiArchivePage(
          headers(cookie)
        )
        assert.isUndefined(lastDeepRun)
        const states = coverage.flatMap(({ years }) =>
          years.flatMap(({ months }) => months)
        )
        assert.strictEqual(states.length, 2 * (18 * 12 + 11))
        assert.deepStrictEqual(
          states.filter((state) => state !== NEVER),
          ["held"]
        )
        assert.strictEqual(monthOf(coverage[1], 2015, 6), "held")
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
