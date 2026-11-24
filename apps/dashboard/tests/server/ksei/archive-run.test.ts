import { assert, describe, it } from "@effect/vitest"
import type { StepConfig } from "@workspace/server"
import { Duration, Effect, Layer, Schema } from "effect"

import type { ArchiveDb } from "@/server/archive/archive-db"
import { readAlone } from "@/server/archive/page-read"
import { RunId } from "@/server/archive/run"
import {
  kseiArchiveRun,
  MAX_KSEI_REPORT_BYTES,
} from "@/server/ksei/archive-run"
import {
  LISTING_URLS,
  MAX_LISTED_REPORT_BYTES,
  MAX_LISTED_REPORTS,
  MAX_LISTING_BYTES,
} from "@/server/ksei/listing"
import { kseiReportIndex } from "@/server/ksei/report-index"
import { KseiRunSummary } from "@/server/ksei/run-result"

import { localSteps } from "../archive/local-steps.ts"
import {
  failingFirstReportInsert,
  type MemoryArchiveDb,
  memoryArchiveDb,
} from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import { archiveDbOf, KSEI_ARCHIVE, storedRun } from "../archive/runs.ts"
import {
  etagOf,
  type FakeKsei,
  fakeKsei,
  fileOf,
  LAST_MODIFIED,
  type ListingEntry,
  md5,
  RECORDED,
  zipBody,
} from "./fake-ksei.ts"

const run = (
  ksei: FakeKsei,
  bucket: MemoryBucket,
  id: string,
  startedAt = new Date("2026-11-14T03:00:00Z"),
  db: { readonly layer: Layer.Layer<ArchiveDb> } = archiveDbOf(bucket)
) =>
  kseiArchiveRun(
    localSteps(Layer.mergeAll(ksei.layer, bucket.layer, db.layer)),
    {
      id: RunId.make(id),
      trigger: "cron",
      startedAt,
    }
  )

const keysUnder = (bucket: MemoryBucket, prefix: string) =>
  [...bucket.objects.keys()].filter((key) => key.startsWith(prefix)).sort()

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => Buffer.from(digest).toString("hex")))

const json = (bucket: MemoryBucket, key: string) =>
  JSON.parse(bucket.objects.get(key)?.body ?? "null")

// The run record of `id`, as its row holds it.
const runRecordOf = (bucket: MemoryBucket, id: string) =>
  storedRun(archiveDbOf(bucket), KSEI_ARCHIVE, id)

// The summary the recent runs table shows of `id`.
const summaryOf = (bucket: MemoryBucket, id: string) =>
  Schema.decodeUnknownSync(KseiRunSummary)(runRecordOf(bucket, id))

const assertNothingOverwritten = (bucket: MemoryBucket) => {
  const reportPuts = bucket.puts.filter((key) => key.startsWith("reports/"))
  assert.deepStrictEqual(
    reportPuts.filter((key, index) => reportPuts.indexOf(key) !== index),
    []
  )
}

const recordsOf = (bucket: MemoryBucket, filename: string) =>
  keysUnder(bucket, "reports/").filter(
    (key) =>
      key.endsWith(".json") &&
      bucket.objects.get(key)?.customMetadata.filename === filename
  )

const STATIS_OCT = "StatisEfek20261030.txt.zip"
const STATIS_OCT_URL = `https://www.ksei.co.id/storage/Download/${STATIS_OCT}`
const BALANCEPOS_SEP = "BalanceposEfek20260930.zip"
const BALANCEPOS_SEP_URL = `https://www.ksei.co.id/storage/Download/${BALANCEPOS_SEP}`

describe("a KSEI archive run", () => {
  it.effect("stores every listed file once on the first run", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      const zips = keysUnder(bucket, "reports/").filter((key) =>
        key.endsWith(".zip")
      )
      const records = keysUnder(bucket, "reports/").filter((key) =>
        key.endsWith(".json")
      )
      assert.strictEqual(zips.length, 72)
      assert.strictEqual(records.length, 72)

      const body = zipBody(`text of ${STATIS_OCT}`)
      const hash = yield* sha256(body)
      const zipKey = `reports/securities-statistics/2026-10-30/${hash}.zip`
      assert.include(zips, zipKey)
      assert.strictEqual(bucket.objects.get(zipKey)?.body, body)
      const holdingsHash = yield* sha256(zipBody(`text of ${BALANCEPOS_SEP}`))
      assert.include(
        zips,
        `reports/securities-holdings/2026-09-30/${holdingsHash}.zip`
      )

      const [recordKey] = recordsOf(bucket, STATIS_OCT)
      assert.isDefined(recordKey)
      assert.isTrue(
        recordKey.startsWith(
          `reports/securities-statistics/2026-10-30/${hash}.`
        )
      )
      const stored = json(bucket, recordKey)
      assert.deepStrictEqual(stored, {
        kind: "securities-statistics",
        periodEnd: "2026-10-30",
        filename: STATIS_OCT,
        url: STATIS_OCT_URL,
        listing: {
          date: "2026-10-30T10:20:01.000000Z",
          name: "Master Securities October 30, 2026",
          pdf_en: [{ url: STATIS_OCT_URL, filename: STATIS_OCT }],
        },
        etag: etagOf(body),
        md5: md5(body),
        lastModified: LAST_MODIFIED,
        contentLength: new TextEncoder().encode(body).length,
        fetchedAt: stored.fetchedAt,
        sha256: hash,
      })
      assert.deepStrictEqual(bucket.objects.get(recordKey)?.customMetadata, {
        filename: STATIS_OCT,
        etag: etagOf(body),
        sha256: hash,
        run: "cron-2026-11-14",
      })

      assert.deepInclude(result, {
        id: RunId.make("cron-2026-11-14"),
        trigger: "cron",
        startedAt: "2026-11-14T03:00:00.000Z",
        outcome: "complete",
        reportsAdded: 72,
        newVersions: 0,
        reportsChecked: 0,
        md5Mismatches: [],
        listingFailures: [],
        notStored: [],
        error: null,
      })
      assert.deepStrictEqual(runRecordOf(bucket, "cron-2026-11-14"), result)
      assert.deepStrictEqual(summaryOf(bucket, "cron-2026-11-14"), {
        id: result.id,
        trigger: "cron",
        startedAt: "2026-11-14T03:00:00.000Z",
        outcome: "complete",
        reportsAdded: 72,
        newVersions: 0,
      })
      // No run writes its record or the latest pointer to R2.
      assert.deepStrictEqual(keysUnder(bucket, "runs/"), [])
    })
  )

  it.effect("stores no listed file before the archive's first month", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const old = "StatisEfek20181031.txt.zip"
      const oldUrl = `https://www.ksei.co.id/storage/Download/${old}`
      ksei.listings["securities-statistics"].push({
        ...RECORDED["securities-statistics"][0],
        pdf_en: [{ url: oldUrl, filename: old }],
      })
      ksei.files.set(oldUrl, fileOf(zipBody(old)))
      const bucket = memoryBucket()

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      assert.notInclude(
        ksei.requests.map(({ url }) => url),
        oldUrl
      )
      assert.deepStrictEqual(recordsOf(bucket, old), [])
      assert.deepStrictEqual(
        keysUnder(bucket, "reports/securities-statistics/2018-10-31/"),
        []
      )
      assert.deepInclude(result, { outcome: "complete", reportsAdded: 72 })
    })
  )

  it.effect("writes nothing when nothing changed", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      yield* run(ksei, bucket, "cron-2026-11-14")
      const before = keysUnder(bucket, "reports/")
      bucket.puts.length = 0
      ksei.requests.length = 0

      const result = yield* run(ksei, bucket, "cron-2026-11-15")

      assert.deepStrictEqual(keysUnder(bucket, "reports/"), before)
      assert.deepStrictEqual(
        bucket.puts.filter((key) => key.startsWith("reports/")),
        []
      )
      // The two listings and a HEAD to each listed file, no GET of a file.
      assert.strictEqual(
        ksei.requests.filter(({ method }) => method === "HEAD").length,
        72
      )
      assert.deepStrictEqual(
        ksei.requests
          .filter(({ method }) => method === "GET")
          .map(({ url }) => url)
          .sort(),
        Object.values(LISTING_URLS).sort()
      )
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 0,
        newVersions: 0,
        reportsChecked: 72,
        notStored: [],
      })
    })
  )

  it.effect("gives `head` time for its HEADs at KSEI's slowest answer", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      yield* run(ksei, bucket, "cron-2026-11-14")
      const steps = localSteps(
        Layer.mergeAll(ksei.layer, bucket.layer, memoryArchiveDb().layer)
      )
      const configs = new Map<string, StepConfig | undefined>()

      yield* kseiArchiveRun(
        {
          do: (name, effect, config) => {
            configs.set(name, config)
            return steps.do(name, effect, config)
          },
        },
        {
          id: RunId.make("cron-2026-11-15"),
          trigger: "cron",
          startedAt: new Date("2026-11-15T03:00:00Z"),
        }
      )

      // 72 HEADs four at once: 18 in turn at 8 s, and one stuck request's 2
      // minutes.
      const timeout = configs.get("head")?.timeout
      assert.isAtLeast(
        timeout === undefined ? 0 : Duration.toMillis(timeout),
        18 * 8_000 + 120_000
      )
    })
  )

  it.effect("stores a changed ETag as a new version beside the old one", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      yield* run(ksei, bucket, "cron-2026-11-14")
      const original = zipBody(`text of ${STATIS_OCT}`)
      const corrected = zipBody(`corrected text of ${STATIS_OCT}`)
      ksei.files.set(STATIS_OCT_URL, fileOf(corrected))

      const result = yield* run(ksei, bucket, "cron-2026-11-15")

      const prefix = "reports/securities-statistics/2026-10-30/"
      assert.deepStrictEqual(
        keysUnder(bucket, prefix).filter((key) => key.endsWith(".zip")),
        [
          `${prefix}${yield* sha256(original)}.zip`,
          `${prefix}${yield* sha256(corrected)}.zip`,
        ].sort()
      )
      const records = recordsOf(bucket, STATIS_OCT)
      assert.strictEqual(records.length, 2)
      assert.deepStrictEqual(
        records.map((key) => json(bucket, key).etag).sort(),
        [etagOf(original), etagOf(corrected)].sort()
      )
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 0,
        newVersions: 1,
        reportsChecked: 72,
      })
      assertNothingOverwritten(bucket)
    })
  )

  it.effect("writes nothing for a file moved to a new path with its ETag", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      yield* run(ksei, bucket, "cron-2026-11-14")
      bucket.puts.length = 0
      // KSEI moved its files once, from /Download/ to /storage/Download/.
      const moved = STATIS_OCT_URL.replace("/storage/Download/", "/Download/")
      const file = ksei.files.get(STATIS_OCT_URL)
      assert.isDefined(file)
      ksei.files.delete(STATIS_OCT_URL)
      ksei.files.set(moved, file)
      ksei.listings["securities-statistics"][0] = {
        ...RECORDED["securities-statistics"][0],
        pdf_en: [{ url: moved, filename: STATIS_OCT }],
      }

      const result = yield* run(ksei, bucket, "cron-2026-11-15")

      assert.include(
        ksei.requests
          .filter(({ method }) => method === "HEAD")
          .map(({ url }) => url),
        moved
      )
      assert.deepStrictEqual(
        bucket.puts.filter((key) => key.startsWith("reports/")),
        []
      )
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 0,
        newVersions: 0,
        reportsChecked: 72,
      })
    })
  )

  it.effect("stores and flags a file whose MD5 isn't its ETag", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      const body = zipBody(`text of ${BALANCEPOS_SEP}`)
      ksei.files.set(BALANCEPOS_SEP_URL, {
        ...fileOf(body),
        etag: '"00000000000000000000000000000000"',
      })

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      const [record] = recordsOf(bucket, BALANCEPOS_SEP)
      assert.isDefined(record)
      assert.deepInclude(json(bucket, record), {
        etag: '"00000000000000000000000000000000"',
        md5: md5(body),
        md5Mismatch: true,
      })
      assert.isTrue(
        bucket.objects.has(
          `reports/securities-holdings/2026-09-30/${yield* sha256(body)}.zip`
        )
      )
      // A matching file's record carries no flag.
      const [matching] = recordsOf(bucket, STATIS_OCT)
      assert.isDefined(matching)
      assert.notProperty(json(bucket, matching), "md5Mismatch")
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 72,
        md5Mismatches: [BALANCEPOS_SEP],
      })
    })
  )

  for (const [label, response] of [
    [
      "answers 405",
      () =>
        Response.json(
          { code: 405, message: "Backend accept only json communication." },
          { status: 405 }
        ),
    ],
    [
      "changes its shape",
      () =>
        Response.json({
          data: RECORDED["securities-holdings"].map(({ pdf_en, ...entry }) => ({
            ...entry,
            pdf_id: pdf_en,
          })),
          meta: { total: 36 },
        }),
    ],
    [
      "counts more files than it lists",
      () =>
        Response.json({
          data: RECORDED["securities-holdings"],
          meta: { total: 37 },
        }),
    ],
  ] as const)
    it.effect(
      `is partial and stores the other kind when one listing ${label}`,
      () =>
        Effect.gen(function* () {
          const ksei = fakeKsei()
          const bucket = memoryBucket()
          ksei.listingResponse["securities-holdings"] = response

          const result = yield* run(ksei, bucket, "cron-2026-11-14")

          assert.strictEqual(
            keysUnder(bucket, "reports/securities-statistics/").length,
            72
          )
          assert.deepStrictEqual(
            keysUnder(bucket, "reports/securities-holdings/"),
            []
          )
          assert.strictEqual(result.outcome, "partial")
          assert.strictEqual(result.reportsAdded, 36)
          assert.deepStrictEqual(
            result.listingFailures.map(({ kind }) => kind),
            ["securities-holdings"]
          )
          assert.include(
            result.listingFailures[0]?.message,
            "KSEI's Securities holdings listing"
          )
          assert.deepStrictEqual(runRecordOf(bucket, "cron-2026-11-14"), result)
        })
    )

  it.effect("fails when neither listing can be read, and says why", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      const refused = () => new Response("Method Not Allowed", { status: 405 })
      ksei.listingResponse["securities-statistics"] = refused
      ksei.listingResponse["securities-holdings"] = refused

      const error = yield* Effect.flip(run(ksei, bucket, "cron-2026-11-14"))

      assert.strictEqual(error.step, "plan")
      assert.include(
        error.message,
        "KSEI's Securities statistics listing answered 405"
      )
      assert.include(
        error.message,
        "KSEI's Securities holdings listing answered 405"
      )
      assert.deepStrictEqual(keysUnder(bucket, "reports/"), [])
      assert.deepInclude(runRecordOf(bucket, "cron-2026-11-14"), {
        outcome: "failed",
        error: error.message,
      })
    })
  )

  it.effect(
    "is partial on a file that redirects, and retries it next run",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        const bucket = memoryBucket()
        const file = ksei.files.get(STATIS_OCT_URL)
        assert.isDefined(file)
        ksei.files.delete(STATIS_OCT_URL)

        const first = yield* run(ksei, bucket, "cron-2026-11-14")

        assert.deepInclude(first, {
          outcome: "partial",
          reportsAdded: 71,
          notStored: [STATIS_OCT],
        })
        assert.deepStrictEqual(recordsOf(bucket, STATIS_OCT), [])
        // A redirect isn't retried within the run: one GET.
        assert.strictEqual(
          ksei.requests.filter(({ url }) => url === STATIS_OCT_URL).length,
          1
        )

        ksei.files.set(STATIS_OCT_URL, file)
        const second = yield* run(ksei, bucket, "cron-2026-11-15")

        assert.deepInclude(second, {
          outcome: "complete",
          reportsAdded: 1,
          notStored: [],
        })
        assert.strictEqual(recordsOf(bucket, STATIS_OCT).length, 1)
      })
  )

  it.effect("stores nothing of a file that answers a page, not a zip", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      ksei.files.set(
        STATIS_OCT_URL,
        fileOf("<!doctype html><title>KSEI</title>")
      )

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      assert.deepInclude(result, {
        outcome: "partial",
        notStored: [STATIS_OCT],
      })
      assert.deepStrictEqual(
        keysUnder(bucket, "reports/securities-statistics/2026-10-30/"),
        []
      )
    })
  )

  it.effect("asks KSEI past any cache and follows no redirect", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      yield* run(ksei, bucket, "cron-2026-11-14")
      ksei.files.delete(STATIS_OCT_URL)
      yield* run(ksei, bucket, "cron-2026-11-15")

      assert.isAbove(ksei.requests.length, 144)
      assert.deepStrictEqual(
        new Set(
          ksei.requests.map(({ cache, redirect }) => `${cache} ${redirect}`)
        ),
        new Set(["no-store manual"])
      )
      // Without it, the listing API answers 405.
      assert.deepStrictEqual(
        ksei.requests
          .filter(({ url }) => url.includes("/api/"))
          .map(({ accept }) => accept),
        Array(4).fill("application/json")
      )
    })
  )
})

describe("a KSEI archive run at the largest size it accepts", () => {
  const STATISTICS = "securities-statistics"
  const HOLDINGS = "securities-holdings"

  // A listed file whose ListedKseiReport takes `bytes` as JSON.
  const entryAt = (
    kind: typeof STATISTICS | typeof HOLDINGS,
    index: number,
    bytes: number
  ): ListingEntry => {
    const filename = `${kind === STATISTICS ? "StatisEfek" : "BalanceposEfek"}${20190101 + index}${kind === STATISTICS ? ".txt.zip" : ".zip"}`
    const url = `https://www.ksei.co.id/storage/Download/${filename}`
    const entry = (name: string) => ({
      date: "2026-10-30T10:20:01.000000Z",
      name,
      pdf_en: [{ url, filename }],
    })
    const reportBytes = (name: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          kind,
          periodEnd: "2019-01-01",
          filename,
          url,
          listing: entry(name),
        })
      ).length
    const name = "x".repeat(bytes - reportBytes(""))
    assert.strictEqual(reportBytes(name), bytes)
    return entry(name)
  }

  const fill = (ksei: FakeKsei, count: number, bytes: number) => {
    for (const kind of [STATISTICS, HOLDINGS] as const) {
      ksei.listings[kind].splice(
        0,
        Infinity,
        ...Array.from({ length: count }, (_, index) =>
          entryAt(kind, index, bytes)
        )
      )
      for (const { pdf_en } of ksei.listings[kind])
        for (const { url, filename } of pdf_en)
          ksei.files.set(url, fileOf(zipBody(filename)))
    }
  }

  it.effect(
    "keeps every step's result under the step limit",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        fill(ksei, MAX_LISTED_REPORTS, MAX_LISTED_REPORT_BYTES)
        const bucket = memoryBucket()

        const first = yield* run(ksei, bucket, "cron-2026-11-14")
        assert.deepInclude(first, {
          outcome: "complete",
          reportsAdded: 2 * MAX_LISTED_REPORTS,
        })
        // `head` lists every held file as changed.
        for (const [url, file] of ksei.files)
          ksei.files.set(url, fileOf(`${file.body} corrected`))
        const second = yield* run(ksei, bucket, "cron-2026-11-15")
        assert.deepInclude(second, {
          outcome: "complete",
          newVersions: 2 * MAX_LISTED_REPORTS,
          reportsChecked: 2 * MAX_LISTED_REPORTS,
        })
      }),
    120_000
  )

  it.effect("skips a listing past the most files a run holds", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      fill(ksei, MAX_LISTED_REPORTS + 1, 400)
      ksei.listings[STATISTICS].splice(0, Infinity, ...RECORDED[STATISTICS])
      const bucket = memoryBucket()

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      assert.deepInclude(result, { outcome: "partial", reportsAdded: 36 })
      assert.include(
        result.listingFailures[0]?.message,
        `more than the ${MAX_LISTED_REPORTS}`
      )
    })
  )

  it.effect("skips a listing past the most bytes before decoding it", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      ksei.listingResponse[HOLDINGS] = () =>
        new Response(" ".repeat(MAX_LISTING_BYTES + 1))
      const bucket = memoryBucket()

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      assert.deepInclude(result, { outcome: "partial", reportsAdded: 36 })
      assert.include(
        result.listingFailures[0]?.message,
        `is over ${MAX_LISTING_BYTES} bytes`
      )
    })
  )

  it.effect("stores no file past the most bytes", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      ksei.files.set(
        STATIS_OCT_URL,
        fileOf(zipBody("x".repeat(MAX_KSEI_REPORT_BYTES)))
      )
      const bucket = memoryBucket()

      const result = yield* run(ksei, bucket, "cron-2026-11-14")

      assert.deepInclude(result, {
        outcome: "partial",
        reportsAdded: 71,
        notStored: [STATIS_OCT],
      })
    })
  )
})

// What the report index holds, as the admin page reads it: each kind's
// reports, versions and bytes, and the months held.
const indexed = (db: MemoryArchiveDb) =>
  readAlone(kseiReportIndex).pipe(Effect.provide(db.layer))

// The rows `db` has written so far.
const rowsWritten = (db: MemoryArchiveDb) =>
  Number(
    (
      db.database.prepare("SELECT total_changes() AS changes").get() as {
        changes: number
      }
    ).changes
  )

// Every object stored under reports/, zips and records.
const reportBytes = (bucket: MemoryBucket) =>
  [...bucket.objects]
    .filter(([key]) => key.startsWith("reports/"))
    .reduce(
      (sum, [, { body, bytes }]) =>
        sum + (bytes?.length ?? new TextEncoder().encode(body).length),
      0
    )

const recordCount = (bucket: MemoryBucket) =>
  keysUnder(bucket, "reports/").filter((key) => key.endsWith(".json")).length

describe("a KSEI archive run's report index", () => {
  it.effect("indexes each report it stores", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      const db = memoryArchiveDb()
      yield* run(ksei, bucket, "cron-2026-11-14", undefined, db)

      const { totals, monthsHeld } = yield* indexed(db)
      assert.deepStrictEqual(
        totals.kinds.map(({ kind, reports, versions }) => ({
          kind,
          reports,
          versions,
        })),
        [
          { kind: "securities-statistics", reports: 36, versions: 36 },
          { kind: "securities-holdings", reports: 36, versions: 36 },
        ]
      )
      assert.strictEqual(totals.bytes, reportBytes(bucket))
      assert.isTrue(monthsHeld["securities-statistics"].has("2026-10"))
      assert.isTrue(monthsHeld["securities-holdings"].has("2026-09"))
      assert.isFalse(monthsHeld["securities-holdings"].has("2018-10"))
    })
  )

  it.effect(
    "counts a file with several records once, and each of its records",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        const bucket = memoryBucket()
        const db = memoryArchiveDb()
        yield* run(ksei, bucket, "cron-2026-11-14", undefined, db)
        // A new ETag serving the bytes held: a second record of one file.
        const body = zipBody(`text of ${STATIS_OCT}`)
        ksei.files.set(STATIS_OCT_URL, { ...fileOf(body), etag: '"new"' })
        yield* run(
          ksei,
          bucket,
          "cron-2026-11-15",
          new Date("2026-11-15T03:00:00Z"),
          db
        )
        assert.strictEqual(recordsOf(bucket, STATIS_OCT).length, 2)

        const { totals } = yield* indexed(db)
        assert.deepStrictEqual(
          totals.kinds.map(({ kind, reports, versions }) => ({
            kind,
            reports,
            versions,
          })),
          [
            { kind: "securities-statistics", reports: 36, versions: 36 },
            { kind: "securities-holdings", reports: 36, versions: 36 },
          ]
        )
        assert.strictEqual(totals.bytes, reportBytes(bucket))
      })
  )

  it.effect("writes no second record when a report's index insert fails", () =>
    Effect.gen(function* () {
      const ksei = fakeKsei()
      const bucket = memoryBucket()
      const db = memoryArchiveDb()
      const failing = failingFirstReportInsert(db)
      const result = yield* run(
        ksei,
        bucket,
        "cron-2026-11-14",
        undefined,
        failing
      )
      db.failBatch = undefined
      assert.isTrue(failing.failed())

      assert.deepInclude(result, { outcome: "complete", reportsAdded: 72 })
      assert.strictEqual(recordCount(bucket), 72)
      // The next run's heal indexes the record the failed insert left out.
      yield* run(
        ksei,
        bucket,
        "cron-2026-11-15",
        new Date("2026-11-15T03:00:00Z"),
        db
      )
      assert.strictEqual(recordCount(bucket), 72)
      assert.deepStrictEqual(
        (yield* indexed(db)).totals.kinds.map(({ versions }) => versions),
        [36, 36]
      )
    })
  )

  it.effect(
    "indexes the records an earlier run stored before the index existed",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        const bucket = memoryBucket()
        const before = memoryArchiveDb()
        yield* run(ksei, bucket, "cron-2026-11-14", undefined, before)
        const filled = yield* indexed(before)

        // A stage whose bucket filled before ArchiveDb did.
        const db = memoryArchiveDb()
        const result = yield* run(
          ksei,
          bucket,
          "cron-2026-11-15",
          new Date("2026-11-15T03:00:00Z"),
          db
        )

        assert.deepInclude(result, { outcome: "complete", reportsAdded: 0 })
        assert.deepStrictEqual(yield* indexed(db), filled)
      })
  )

  it.effect(
    "writes a row per record it indexes, and none for those indexed",
    () =>
      Effect.gen(function* () {
        const ksei = fakeKsei()
        const bucket = memoryBucket()
        yield* run(ksei, bucket, "cron-2026-11-14")
        const db = memoryArchiveDb()

        yield* run(
          ksei,
          bucket,
          "cron-2026-11-15",
          new Date("2026-11-15T03:00:00Z"),
          db
        )
        // Each run also writes its own row twice: running, then its summary.
        assert.strictEqual(rowsWritten(db), recordCount(bucket) + 2)

        yield* run(
          ksei,
          bucket,
          "cron-2026-11-16",
          new Date("2026-11-16T03:00:00Z"),
          db
        )
        assert.strictEqual(rowsWritten(db), recordCount(bucket) + 4)
      })
  )
})
