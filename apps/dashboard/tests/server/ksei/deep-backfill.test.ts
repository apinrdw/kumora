import { assert, describe, it } from "@effect/vitest"
import type { StepConfig, WorkflowSteps } from "@workspace/server"
import { Duration, Effect, Layer } from "effect"

import { RunId } from "@/server/archive/run"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { unlistedReport } from "@/server/ksei/listing"
import { WAYBACK_SEED } from "@/server/ksei/wayback-seed"

import { localSteps } from "../archive/local-steps.ts"
import { memoryArchiveDb } from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import { type FakeKsei, fakeKsei, fileOf, zipBody } from "./fake-ksei.ts"

const DOWNLOAD = "https://www.ksei.co.id/storage/Download/"

// The KSEI requests each step sent, by step name, and each step's config.
// Steps run one at a time.
const countingSteps = <R>(
  ksei: FakeKsei,
  steps: WorkflowSteps<R>,
  counts: Map<string, number>,
  configs = new Map<string, StepConfig | undefined>()
): WorkflowSteps<R> => ({
  do: (name, effect, config) =>
    Effect.suspend(() => {
      const before = ksei.requests.length
      configs.set(name, config)
      return steps
        .do(name, effect, config)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => counts.set(name, ksei.requests.length - before))
          )
        )
    }),
})

const deepRun = (
  ksei: FakeKsei,
  bucket: MemoryBucket,
  id: string,
  counts = new Map<string, number>(),
  configs = new Map<string, StepConfig | undefined>()
) =>
  kseiArchiveRun(
    countingSteps(
      ksei,
      localSteps(
        Layer.mergeAll(ksei.layer, bucket.layer, memoryArchiveDb().layer)
      ),
      counts,
      configs
    ),
    {
      id: RunId.make(id),
      trigger: "deep",
      startedAt: new Date("2026-11-14T03:00:00Z"),
    }
  )

const serve = (ksei: FakeKsei, filename: string) =>
  ksei.files.set(
    `${DOWNLOAD}${filename}`,
    fileOf(zipBody(`text of ${filename}`))
  )

const recordOf = (bucket: MemoryBucket, filename: string) => {
  const records = [...bucket.objects.entries()].filter(
    ([key, { customMetadata }]) =>
      key.endsWith(".json") && customMetadata.filename === filename
  )
  assert.strictEqual(records.length, 1, `one record of ${filename}`)
  const [key = "", object] = records[0] ?? []
  return { key, record: JSON.parse(object?.body ?? "null") }
}

const reportPuts = (bucket: MemoryBucket) =>
  bucket.puts.filter((key) => key.startsWith("reports/"))

// Seeded from Wayback: both are in the committed seed.
const SEEDED_STATIS = "StatisEfek20230131.txt.zip"
const SEEDED_BALANCEPOS = "BalanceposEfek20210730.zip"
// June 2019's Kepemilikan Efek is in no seed: its period end is Friday the
// 28th.
const PROBED_BALANCEPOS = "BalanceposEfek20190628.zip"
// Before the archive's first month, November 2018: one seeded, one a probe
// would find.
const OLD_SEEDED = "StatisEfek20080131.txt.zip"
const OLD_UNSEEDED = "BalanceposEfek20181031.zip"

describe("the Wayback seed", () => {
  it.effect("names only KSEI reports, each once", () =>
    Effect.gen(function* () {
      assert.strictEqual(new Set(WAYBACK_SEED).size, WAYBACK_SEED.length)
      for (const filename of WAYBACK_SEED)
        assert.isDefined(yield* unlistedReport(filename), filename)
      assert.isUndefined(yield* unlistedReport("Nonexistent123.zip"))
    })
  )

  // The same names as scripts/ksei-wayback-seed.test.mts.
  it.effect("takes a filename only under its kind's own suffixes", () =>
    Effect.gen(function* () {
      for (const filename of [
        "StatisEfek20200131.txt.zip",
        "BalanceposEfek20200131.zip",
        "BalanceposEfek20081031.txt.zip",
      ])
        assert.isDefined(yield* unlistedReport(filename), filename)
      assert.isUndefined(yield* unlistedReport("StatisEfek20200131.zip"))
    })
  )
})

describe("a deep backfill", () => {
  it.effect(
    "stores seeded files with no listing, and probes the months still missing",
    () =>
      Effect.gen(function* () {
        assert.include(WAYBACK_SEED, SEEDED_STATIS)
        assert.include(WAYBACK_SEED, SEEDED_BALANCEPOS)
        assert.notInclude(WAYBACK_SEED, PROBED_BALANCEPOS)
        const ksei = fakeKsei()
        for (const filename of [
          SEEDED_STATIS,
          SEEDED_BALANCEPOS,
          PROBED_BALANCEPOS,
        ])
          serve(ksei, filename)
        const bucket = memoryBucket()

        const result = yield* deepRun(ksei, bucket, "deep-1763089200000")

        const seeded = recordOf(bucket, SEEDED_BALANCEPOS)
        assert.isTrue(
          seeded.key.startsWith("reports/securities-holdings/2021-07-30/")
        )
        assert.deepInclude(seeded.record, {
          kind: "securities-holdings",
          periodEnd: "2021-07-30",
          filename: SEEDED_BALANCEPOS,
          url: `${DOWNLOAD}${SEEDED_BALANCEPOS}`,
          listing: null,
        })
        assert.deepInclude(recordOf(bucket, SEEDED_STATIS).record, {
          kind: "securities-statistics",
          periodEnd: "2023-01-31",
          listing: null,
        })
        const probed = recordOf(bucket, PROBED_BALANCEPOS)
        assert.isTrue(
          probed.key.startsWith("reports/securities-holdings/2019-06-28/")
        )
        assert.deepInclude(probed.record, {
          url: `${DOWNLOAD}${PROBED_BALANCEPOS}`,
          listing: null,
        })
        // Newest first, each day under both names, stopping at the find.
        assert.deepStrictEqual(
          ksei.requests
            .filter(
              ({ method, url }) =>
                method === "HEAD" && url.includes("BalanceposEfek201906")
            )
            .map(({ url }) => url.slice(DOWNLOAD.length)),
          [
            "BalanceposEfek20190630.zip",
            "BalanceposEfek20190630.txt.zip",
            "BalanceposEfek20190629.zip",
            "BalanceposEfek20190629.txt.zip",
            "BalanceposEfek20190628.zip",
          ]
        )

        assert.deepInclude(result, {
          trigger: "deep",
          outcome: "complete",
          // The 72 listed and the three found.
          reportsAdded: 75,
          notStored: [],
        })
        assert.isNotNull(result.deep)
        const deep = result.deep!
        assert.deepStrictEqual(
          [...deep.foundFromSeed].sort(),
          [SEEDED_BALANCEPOS, SEEDED_STATIS].sort()
        )
        assert.deepStrictEqual(deep.foundByProbing, [PROBED_BALANCEPOS])
        const notFound = deep.monthsNotFound
        // Nothing serves May 2019's Statistik Efek.
        assert.include(notFound["securities-statistics"], "2019-05")
        for (const held of ["2021-07", "2019-06", "2023-11"])
          assert.notInclude(notFound["securities-holdings"], held)
        assert.notInclude(notFound["securities-statistics"], "2023-01")
        // Every month from November 2018 to 2023 but those held: the listing
        // holds Nov and Dec 2023.
        assert.strictEqual(notFound["securities-statistics"][0], "2018-11")
        assert.strictEqual(notFound["securities-statistics"].length, 62 - 3)
        assert.strictEqual(notFound["securities-holdings"].length, 62 - 4)
      }),
    30_000
  )

  it.effect(
    "asks KSEI for nothing before the archive's first month",
    () =>
      Effect.gen(function* () {
        assert.include(WAYBACK_SEED, OLD_SEEDED)
        const ksei = fakeKsei()
        serve(ksei, OLD_SEEDED)
        serve(ksei, OLD_UNSEEDED)
        const bucket = memoryBucket()
        const counts = new Map<string, number>()

        const result = yield* deepRun(
          ksei,
          bucket,
          "deep-1763089200000",
          counts
        )

        const asked = ksei.requests.map(({ url }) => url)
        assert.notInclude(asked, `${DOWNLOAD}${OLD_SEEDED}`)
        assert.notInclude(asked, `${DOWNLOAD}${OLD_UNSEEDED}`)
        assert.deepStrictEqual(
          asked.filter((url) => /Efek(?:2017|20180)/.test(url)),
          []
        )
        assert.isFalse(
          reportPuts(bucket).some((key) =>
            /^reports\/[a-z-]+\/(?:200|201[0-7]|2018-(?:0|10))/.test(key)
          )
        )
        assert.deepInclude(result, { outcome: "complete", reportsAdded: 72 })
        // 2018 is probed for November and December only.
        assert.isAtMost(
          counts.get("probe:securities-holdings:2018") ?? 0,
          2 * 7 * 2
        )
        for (const kind of [
          "securities-statistics",
          "securities-holdings",
        ] as const)
          assert.deepStrictEqual(
            result.deep?.monthsNotFound[kind].slice(0, 3),
            ["2018-11", "2018-12", "2019-01"]
          )
      }),
    30_000
  )

  it.effect(
    "fetches nothing on a second run",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        for (const filename of [SEEDED_STATIS, PROBED_BALANCEPOS])
          serve(ksei, filename)
        const bucket = memoryBucket()
        const first = yield* deepRun(ksei, bucket, "deep-1763089200000")
        bucket.puts.length = 0
        ksei.requests.length = 0

        const second = yield* deepRun(ksei, bucket, "deep-1763175600000")

        assert.deepStrictEqual(reportPuts(bucket), [])
        // No file is downloaded: every GET of a file is a seeded name KSEI
        // doesn't serve.
        const fileGets = ksei.requests.filter(
          ({ method, url }) => method === "GET" && url.startsWith(DOWNLOAD)
        )
        assert.isAbove(fileGets.length, 0)
        for (const { url } of fileGets)
          assert.isFalse(ksei.files.has(url), `${url} downloaded again`)
        // Held months aren't probed again.
        assert.notInclude(
          ksei.requests.map(({ url }) => url),
          `${DOWNLOAD}BalanceposEfek20190630.zip`
        )
        assert.deepInclude(second, {
          outcome: "complete",
          reportsAdded: 0,
          newVersions: 0,
        })
        assert.deepStrictEqual(second.deep?.foundFromSeed, [])
        assert.deepStrictEqual(second.deep?.foundByProbing, [])
        assert.deepStrictEqual(
          second.deep?.monthsNotFound,
          first.deep?.monthsNotFound
        )
      }),
    30_000
  )

  it.effect(
    "stays inside a Workflow's limits when KSEI serves nothing unlisted",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        const bucket = memoryBucket()
        const counts = new Map<string, number>()

        const result = yield* deepRun(
          ksei,
          bucket,
          "deep-1763089200000",
          counts
        )

        const probes = [...counts].filter(([name]) => name.startsWith("probe:"))
        // One probe step per kind and year, 2018 to 2023.
        assert.strictEqual(probes.length, 2 * 6)
        assert.include(
          probes.map(([name]) => name),
          "probe:securities-holdings:2018"
        )
        // Twelve months of seven days under two names, at most.
        for (const [name, sent] of probes)
          assert.isAtMost(sent, 12 * 7 * 2, name)
        // Each instance may send 10,000 subrequests and run 10,000 steps
        // (docs/research/cloudflare-workflows-shareholding-archive.md).
        assert.isBelow(ksei.requests.length, 10_000)
        assert.isBelow(counts.size, 1_000)
        assert.strictEqual(result.outcome, "complete")
        assert.deepStrictEqual(result.deep?.foundFromSeed, [])
      }),
    30_000
  )

  it.effect(
    "gives each step time for the KSEI requests it sends in turn",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        serve(ksei, SEEDED_STATIS)
        serve(ksei, PROBED_BALANCEPOS)
        const configs = new Map<string, StepConfig | undefined>()

        yield* deepRun(
          ksei,
          memoryBucket(),
          "deep-1763089200000",
          new Map(),
          configs
        )

        const timeoutOf = (name: string) => {
          const timeout = configs.get(name)?.timeout
          return timeout === undefined ? undefined : Duration.toMillis(timeout)
        }
        // One request at a time: 2 minutes.
        for (const name of [
          "plan",
          `report:${SEEDED_STATIS}`,
          `report:${PROBED_BALANCEPOS}`,
        ])
          assert.strictEqual(timeoutOf(name), 120_000, name)
        // Twelve months, four at once, each up to seven days under two names:
        // 42 HEADs in turn at KSEI's slowest 8 s, and one stuck request's 2
        // minutes.
        for (const name of [...configs.keys()].filter((step) =>
          step.startsWith("probe:")
        ))
          assert.isAtLeast(timeoutOf(name) ?? 0, 42 * 8_000 + 120_000, name)
        // `seed` and `summary` ask KSEI nothing.
        assert.isUndefined(configs.get("seed"))
        assert.isUndefined(configs.get("summary"))
      }),
    30_000
  )

  it.effect(
    "is partial when a probe keeps failing, and lists none of its months",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        ksei.files.set(`${DOWNLOAD}StatisEfek20200531.txt.zip`, {
          ...fileOf(zipBody("May 2020")),
          status: 503,
        })
        const bucket = memoryBucket()

        const result = yield* deepRun(ksei, bucket, "deep-1763089200000")

        assert.strictEqual(result.outcome, "partial")
        assert.deepStrictEqual(
          result.deep?.probeFailures.map(({ kind, year }) => ({ kind, year })),
          [{ kind: "securities-statistics", year: 2020 }]
        )
        assert.include(result.deep?.probeFailures[0]?.message ?? "", "503")
        const statistics =
          result.deep?.monthsNotFound["securities-statistics"] ?? []
        assert.notInclude(statistics, "2020-05")
        assert.notInclude(statistics, "2020-02")
        assert.include(statistics, "2019-12")
        assert.include(
          result.deep?.monthsNotFound["securities-holdings"] ?? [],
          "2020-05"
        )
      }),
    30_000
  )

  it.effect(
    "fails a probe KSEI answers 429, rather than finding its month absent",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        ksei.files.set(`${DOWNLOAD}BalanceposEfek20200331.zip`, {
          ...fileOf(zipBody("March 2020")),
          status: 429,
        })
        const bucket = memoryBucket()

        const result = yield* deepRun(ksei, bucket, "deep-1763089200000")

        assert.strictEqual(result.outcome, "partial")
        assert.deepStrictEqual(
          result.deep?.probeFailures.map(({ kind, year }) => ({ kind, year })),
          [{ kind: "securities-holdings", year: 2020 }]
        )
        assert.include(result.deep?.probeFailures[0]?.message ?? "", "429")
        assert.notInclude(
          result.deep?.monthsNotFound["securities-holdings"] ?? [],
          "2020-03"
        )
      }),
    30_000
  )
})
