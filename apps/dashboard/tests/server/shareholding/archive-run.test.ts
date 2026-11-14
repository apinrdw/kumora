import { assert, describe, it } from "@effect/vitest"
import { StepFailed } from "@workspace/server"
import { Effect, Layer, Schema } from "effect"

import { archiveRun, MAX_REPORT_BYTES } from "@/server/shareholding/archive-run"
import {
  ArchiveRunId,
  MAX_RUN_ERROR_LENGTH,
  RunMetadata,
} from "@/server/shareholding/run-result"
import {
  LISTING_URL,
  MAX_ETAG_BYTES,
  MAX_LISTED_REPORT_BYTES,
  MAX_LISTED_REPORTS,
  MAX_LISTING_BYTES,
} from "@/server/shareholding/listing"

import { fakeIdx, type FakeIdx, idxIdUrl } from "./fake-idx.ts"
import { localSteps } from "./local-steps.ts"
import { type MemoryBucket, memoryBucket } from "./memory-bucket.ts"

const run = (
  idx: FakeIdx,
  bucket: MemoryBucket,
  id: string,
  startedAt = new Date("2026-11-14T13:00:00Z")
) =>
  archiveRun(localSteps(Layer.merge(idx.layer, bucket.layer)), {
    id: ArchiveRunId.make(id),
    trigger: "cron",
    startedAt,
  })

const keysUnder = (bucket: MemoryBucket, prefix: string) =>
  [...bucket.objects.keys()].filter((key) => key.startsWith(prefix)).sort()

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => Buffer.from(digest).toString("hex")))

const json = (bucket: MemoryBucket, key: string) =>
  JSON.parse(bucket.objects.get(key)?.body ?? "null")

// The summary a run record carries as custom metadata.
const summaryOf = (bucket: MemoryBucket, key: string) =>
  Schema.decodeUnknownSync(RunMetadata)(bucket.objects.get(key)?.customMetadata)
    .run

// Every key under reports/ written at most once, across all runs so far.
const assertNothingOverwritten = (bucket: MemoryBucket) => {
  const reportPuts = bucket.puts.filter((key) => key.startsWith("reports/"))
  assert.deepStrictEqual(
    reportPuts.filter((key, index) => reportPuts.indexOf(key) !== index),
    []
  )
}

const recordsOf = (bucket: MemoryBucket, sourceUrl: string) =>
  keysUnder(bucket, "reports/").filter(
    (key) =>
      key.endsWith(".json") &&
      bucket.objects.get(key)?.customMetadata.sourceUrl === sourceUrl
  )

describe("an archive run", () => {
  it.effect("stores every listed report once on the first run", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      const result = yield* run(idx, bucket, "cron-2026-11-14T13")

      const xlsx = keysUnder(bucket, "reports/").filter((key) =>
        key.endsWith(".xlsx")
      )
      const records = keysUnder(bucket, "reports/").filter((key) =>
        key.endsWith(".json")
      )
      assert.strictEqual(xlsx.length, 145)
      assert.strictEqual(records.length, 145)

      // A daily above-5 report, and a month-end report by investor type
      // whose description has trailing whitespace.
      const daily = idx.listing[0]
      assert.strictEqual(
        daily.Description,
        "Pemegang Saham di Atas 5% per 12 November 2026"
      )
      const dailyHash = yield* sha256(`xlsx bytes of ${daily.Prospectus}`)
      assert.include(xlsx, `reports/above-5/2026-11-12/${dailyHash}.xlsx`)
      const typeReport = idx.listing.find((item) =>
        item.Prospectus.endsWith("peng-05-00010-tipe.xlsx")
      )
      assert.isDefined(typeReport)
      const typeHash = yield* sha256(`xlsx bytes of ${typeReport.Prospectus}`)
      assert.include(xlsx, `reports/investor-type/2026-05-29/${typeHash}.xlsx`)
      assert.strictEqual(
        bucket.objects.get(`reports/investor-type/2026-05-29/${typeHash}.xlsx`)
          ?.body,
        `xlsx bytes of ${typeReport.Prospectus}`
      )

      const [typeRecordKey] = records.filter((key) =>
        key.startsWith(`reports/investor-type/2026-05-29/${typeHash}.`)
      )
      assert.isDefined(typeRecordKey)
      assert.deepStrictEqual(json(bucket, typeRecordKey), {
        description:
          "Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor per 29 Mei 2026",
        rawDescription:
          "Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor per 29 Mei 2026  \n",
        dataDate: "2026-05-29",
        kind: "investor-type",
        sourceUrl: typeReport.Prospectus,
        fetchedUrl: idxIdUrl(typeReport.Prospectus),
        etag: idx.files.get(idxIdUrl(typeReport.Prospectus))?.etag,
        lastModified: "Fri, 13 Nov 2026 10:28:42 GMT",
        fetchedAt: json(bucket, typeRecordKey).fetchedAt,
        sha256: typeHash,
      })
      assert.deepStrictEqual(
        bucket.objects.get(typeRecordKey)?.customMetadata,
        {
          sourceUrl: typeReport.Prospectus,
          etag: idx.files.get(idxIdUrl(typeReport.Prospectus))?.etag ?? "",
          sha256: typeHash,
          run: "cron-2026-11-14T13",
        }
      )

      const kinds = new Set(xlsx.map((key) => key.split("/")[1]))
      assert.deepStrictEqual([...kinds].sort(), [
        "above-1",
        "above-5",
        "investor-classification",
        "investor-type",
      ])

      // Never www.idx.co.id.
      assert.isTrue(
        idx.requests.every((url) => url.startsWith("https://www.idx.id/"))
      )

      assert.deepInclude(result, {
        id: ArchiveRunId.make("cron-2026-11-14T13"),
        trigger: "cron",
        startedAt: "2026-11-14T13:00:00.000Z",
        outcome: "complete",
        reportsAdded: 145,
        newVersions: 0,
        reportsChecked: 0,
        notStored: [],
        other: [],
        error: null,
      })
      assert.deepStrictEqual(
        json(bucket, "runs/cron-2026-11-14T13.json"),
        result
      )
      assert.deepStrictEqual(
        summaryOf(bucket, "runs/cron-2026-11-14T13.json"),
        {
          id: result.id,
          trigger: "cron",
          startedAt: "2026-11-14T13:00:00.000Z",
          outcome: "complete",
          reportsAdded: 145,
          newVersions: 0,
        }
      )
      // The run's start points runs/latest.json at it, never the run.
      assert.notInclude(bucket.puts, "runs/latest.json")
    })
  )

  it.effect("stores nothing new when nothing changed", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")
      const before = keysUnder(bucket, "reports/")
      bucket.puts.length = 0
      idx.requests.length = 0

      const result = yield* run(
        idx,
        bucket,
        "cron-2026-11-14T13",
        new Date("2026-11-14T13:00:00Z")
      )

      // A HEAD to every held URL, and no download.
      const heldUrls = idx.listing.map((item) => idxIdUrl(item.Prospectus))
      assert.sameMembers(idx.heads, heldUrls)
      assert.sameMembers(
        idx.requests.filter((url) => url !== LISTING_URL),
        heldUrls
      )
      assert.deepStrictEqual(keysUnder(bucket, "reports/"), before)
      assert.deepStrictEqual(
        bucket.puts.filter((key) => key.startsWith("reports/")),
        []
      )
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 0,
        newVersions: 0,
        reportsChecked: 145,
      })
      assert.strictEqual(
        json(bucket, "runs/cron-2026-11-14T06.json").outcome,
        "complete"
      )
    })
  )

  it.effect(
    "keeps a report IDX replaced in place as a new version beside the old one",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const bucket = memoryBucket()
        yield* run(idx, bucket, "cron-2026-11-14T06")
        const before = new Map(bucket.objects)

        const daily = idx.listing[0]
        const url = idxIdUrl(daily.Prospectus)
        idx.files.set(url, {
          body: `corrected xlsx bytes of ${daily.Prospectus}`,
          etag: `"etag-0:1"`,
          lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
        })
        const result = yield* run(idx, bucket, "cron-2026-11-14T13")

        const oldHash = yield* sha256(`xlsx bytes of ${daily.Prospectus}`)
        const newHash = yield* sha256(
          `corrected xlsx bytes of ${daily.Prospectus}`
        )
        const dir = "reports/above-5/2026-11-12/"
        assert.includeMembers(keysUnder(bucket, dir), [
          `${dir}${oldHash}.xlsx`,
          `${dir}${newHash}.xlsx`,
        ])
        assert.strictEqual(
          bucket.objects.get(`${dir}${newHash}.xlsx`)?.body,
          `corrected xlsx bytes of ${daily.Prospectus}`
        )
        const records = recordsOf(bucket, daily.Prospectus)
        assert.deepStrictEqual(
          records.map((key) => json(bucket, key).etag).sort(),
          [`"etag-0:0"`, `"etag-0:1"`]
        )

        // Every object of the first run is still there, unchanged.
        for (const [key, object] of before)
          if (key.startsWith("reports/"))
            assert.deepStrictEqual(bucket.objects.get(key), object)
        assertNothingOverwritten(bucket)

        assert.deepInclude(result, {
          outcome: "complete",
          reportsAdded: 0,
          newVersions: 1,
          reportsChecked: 145,
        })
      })
  )

  it.effect("counts a new version whose record took a retry to write", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")

      const daily = idx.listing[0]
      idx.files.set(idxIdUrl(daily.Prospectus), {
        body: `corrected xlsx bytes of ${daily.Prospectus}`,
        etag: `"etag-0:1"`,
        lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
      })
      // The .xlsx is written, then its record's first write fails.
      bucket.failPut = (key) =>
        key.startsWith("reports/above-5/2026-11-12/") && key.endsWith(".json")
      const result = yield* run(idx, bucket, "cron-2026-11-14T13")

      assert.strictEqual(recordsOf(bucket, daily.Prospectus).length, 2)
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 0,
        newVersions: 1,
      })
    })
  )

  it.effect(
    "adds only a record when a changed ETag serves the same bytes",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const bucket = memoryBucket()
        yield* run(idx, bucket, "cron-2026-11-14T06")
        const before = keysUnder(bucket, "reports/")

        const daily = idx.listing[0]
        const url = idxIdUrl(daily.Prospectus)
        const file = idx.files.get(url)
        assert.isDefined(file)
        idx.files.set(url, { ...file, etag: `"etag-0:1"` })
        const result = yield* run(idx, bucket, "cron-2026-11-14T13")

        const added = keysUnder(bucket, "reports/").filter(
          (key) => !before.includes(key)
        )
        const hash = yield* sha256(file.body)
        assert.strictEqual(added.length, 1)
        assert.match(
          added[0],
          new RegExp(`^reports/above-5/2026-11-12/${hash}\\..+\\.json$`)
        )
        assert.deepInclude(json(bucket, added[0]), {
          sourceUrl: daily.Prospectus,
          etag: `"etag-0:1"`,
          sha256: hash,
        })
        assertNothingOverwritten(bucket)

        // The file itself didn't change: no new version.
        assert.deepInclude(result, {
          reportsAdded: 0,
          newVersions: 0,
          reportsChecked: 145,
        })

        // The new ETag is held now: the next run stores nothing.
        const held = keysUnder(bucket, "reports/")
        yield* run(idx, bucket, "cron-2026-11-15T06")
        assert.deepStrictEqual(keysUnder(bucket, "reports/"), held)
      })
  )

  it.effect(
    "stores a report up to the size cap, and gives up on one past it",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const [atCap, pastCap] = idx.listing
        const urlAt = idxIdUrl(atCap.Prospectus)
        const urlPast = idxIdUrl(pastCap.Prospectus)
        for (const [url, size] of [
          [urlAt, MAX_REPORT_BYTES],
          [urlPast, MAX_REPORT_BYTES + 1],
        ] as const) {
          const file = idx.files.get(url)
          assert.isDefined(file)
          idx.files.set(url, { ...file, body: "x".repeat(size) })
        }
        const bucket = memoryBucket()

        const result = yield* run(idx, bucket, "cron-2026-11-14T06")

        assert.deepStrictEqual(result.notStored, [pastCap.Prospectus])
        assert.strictEqual(recordsOf(bucket, atCap.Prospectus).length, 1)
        assert.deepStrictEqual(recordsOf(bucket, pastCap.Prospectus), [])
        // Too big is final: no retries.
        assert.strictEqual(
          idx.requests.filter((url) => url === urlPast).length,
          1
        )
      }),
    20_000
  )

  it.effect("reads a weak HEAD ETag as the same as the GET's strong one", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      for (const [url, file] of idx.files)
        idx.files.set(url, {
          ...file,
          headEtag: `W/${file.etag}`,
        })
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")
      idx.requests.length = 0

      const result = yield* run(idx, bucket, "cron-2026-11-14T13")

      assert.sameMembers(
        idx.requests.filter((url) => url !== LISTING_URL),
        idx.heads
      )
      assert.deepInclude(result, {
        outcome: "complete",
        newVersions: 0,
        reportsChecked: 145,
      })
    })
  )

  it.effect("downloads a report whose GET has no ETag at most once more", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const daily = idx.listing[0]
      const url = idxIdUrl(daily.Prospectus)
      const file = idx.files.get(url)
      assert.isDefined(file)
      idx.files.set(url, { ...file, etag: null, headEtag: `"etag-0:0"` })
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")

      const downloads = () =>
        idx.requests.filter((requested) => requested === url).length -
        idx.heads.filter((headed) => headed === url).length
      for (const id of [
        "cron-2026-11-14T13",
        "cron-2026-11-15T06",
        "cron-2026-11-15T13",
      ]) {
        idx.requests.length = 0
        idx.heads.length = 0
        yield* run(idx, bucket, id)
        if (id !== "cron-2026-11-14T13") assert.strictEqual(downloads(), 0, id)
      }
      assertNothingOverwritten(bucket)
    })
  )

  it.effect(
    "adds only a record for the same bytes under a new URL, even within one run",
    () =>
      Effect.gen(function* () {
        // IDX lists the daily report twice, under two URLs, with the same
        // bytes. One run stores both in the same millisecond (the test
        // clock is frozen).
        const [daily, ...rest] = fakeIdx().listing
        const reupload = {
          ...daily,
          Prospectus: daily.Prospectus.replace(".xlsx", "-reupload.xlsx"),
        }
        const idx = fakeIdx([daily, reupload, ...rest])
        const body = `xlsx bytes of ${daily.Prospectus}`
        const reuploadFile = idx.files.get(idxIdUrl(reupload.Prospectus))
        assert.isDefined(reuploadFile)
        idx.files.set(idxIdUrl(reupload.Prospectus), { ...reuploadFile, body })
        const bucket = memoryBucket()

        const result = yield* run(idx, bucket, "cron-2026-11-14T13")

        const hash = yield* sha256(body)
        const dir = "reports/above-5/2026-11-12/"
        assert.deepStrictEqual(
          keysUnder(bucket, dir).filter((key) => key.endsWith(".xlsx")),
          [`${dir}${hash}.xlsx`]
        )
        const records = [
          ...recordsOf(bucket, daily.Prospectus),
          ...recordsOf(bucket, reupload.Prospectus),
        ]
        assert.strictEqual(records.length, 2)
        for (const key of records)
          assert.strictEqual(
            bucket.objects.get(key)?.customMetadata.sha256,
            hash
          )
        assertNothingOverwritten(bucket)
        assert.deepInclude(result, { reportsAdded: 146, newVersions: 0 })

        // Both listings are held now: the next run stores nothing.
        const held = keysUnder(bucket, "reports/")
        yield* run(idx, bucket, "cron-2026-11-15T06")
        assert.deepStrictEqual(keysUnder(bucket, "reports/"), held)
      })
  )

  it.effect(
    "ends partial when a report is gone, without retrying it, and the next run stores it",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const bucket = memoryBucket()
        const gone = idx.listing[1]
        const goneUrl = idxIdUrl(gone.Prospectus)
        const file = idx.files.get(goneUrl)
        assert.isDefined(file)
        idx.files.delete(goneUrl)
        const goneKey = `reports/above-5/2026-11-11/${yield* sha256(file.body)}.xlsx`

        const result = yield* run(idx, bucket, "cron-2026-11-14T06")

        assert.strictEqual(
          idx.requests.filter((url) => url === goneUrl).length,
          1
        )
        assert.isFalse(bucket.objects.has(goneKey))
        assert.deepInclude(result, {
          outcome: "partial",
          reportsAdded: 144,
          notStored: [gone.Prospectus],
          error: null,
        })
        assert.deepStrictEqual(
          json(bucket, "runs/cron-2026-11-14T06.json"),
          result
        )

        idx.files.set(goneUrl, file)
        const next = yield* run(idx, bucket, "cron-2026-11-14T13")

        assert.isTrue(bucket.objects.has(goneKey))
        assert.deepInclude(next, {
          outcome: "complete",
          reportsAdded: 1,
          notStored: [],
        })
      })
  )

  it.effect(
    "ends partial when a held report's HEAD fails, and still stores other changes",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const bucket = memoryBucket()
        yield* run(idx, bucket, "cron-2026-11-14T06")

        const unanswered = idx.listing[3]
        const unansweredUrl = idxIdUrl(unanswered.Prospectus)
        const unansweredFile = idx.files.get(unansweredUrl)
        assert.isDefined(unansweredFile)
        idx.files.set(unansweredUrl, { ...unansweredFile, status: 503 })
        const changed = idx.listing[0]
        const changedUrl = idxIdUrl(changed.Prospectus)
        idx.files.set(changedUrl, {
          body: `corrected xlsx bytes of ${changed.Prospectus}`,
          etag: `"etag-0:1"`,
          lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
        })

        const result = yield* run(idx, bucket, "cron-2026-11-14T13")

        assert.deepInclude(result, {
          outcome: "partial",
          newVersions: 1,
          reportsChecked: 144,
          notStored: [unanswered.Prospectus],
        })
        assert.deepStrictEqual(
          json(bucket, "runs/cron-2026-11-14T13.json"),
          result
        )

        idx.files.set(unansweredUrl, unansweredFile)
        const next = yield* run(idx, bucket, "cron-2026-11-15T06")
        assert.deepInclude(next, {
          outcome: "complete",
          reportsChecked: 145,
          notStored: [],
        })
      })
  )

  it.effect("retries a report IDX fails to serve, then ends partial", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      const failing = idx.listing[2]
      const failingUrl = idxIdUrl(failing.Prospectus)
      const file = idx.files.get(failingUrl)
      assert.isDefined(file)
      idx.files.set(failingUrl, { ...file, status: 500 })

      const result = yield* run(idx, bucket, "cron-2026-11-14T06")

      // A Workflow step's default: 5 retries after the first attempt.
      assert.strictEqual(
        idx.requests.filter((url) => url === failingUrl).length,
        6
      )
      assert.deepInclude(result, {
        outcome: "partial",
        reportsAdded: 144,
        notStored: [failing.Prospectus],
      })
    })
  )

  it.effect("stores a report of an unknown kind under other and flags it", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      const [first] = idx.listing
      idx.listing = [
        {
          ...first,
          Description: " Laporan Kepemilikan Baru per 12 November 2026 ",
        },
      ]

      const result = yield* run(idx, bucket, "cron-2026-11-14T06")

      const hash = yield* sha256(`xlsx bytes of ${first.Prospectus}`)
      assert.isTrue(bucket.objects.has(`reports/other/2026-11-12/${hash}.xlsx`))
      assert.deepInclude(result, {
        outcome: "complete",
        reportsAdded: 1,
        other: [
          {
            sourceUrl: first.Prospectus,
            description: "Laporan Kepemilikan Baru per 12 November 2026",
          },
        ],
      })
    })
  )

  it.effect("fails when IDX refuses the listing, and says so", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      idx.listingResponse = () => new Response("Forbidden", { status: 403 })

      const failure = yield* Effect.flip(run(idx, bucket, "cron-2026-11-14T06"))

      assert.include(failure.message, "403")
      assert.deepInclude(json(bucket, "runs/cron-2026-11-14T06.json"), {
        id: "cron-2026-11-14T06",
        outcome: "failed",
        error: failure.message,
        notStored: [],
      })
      assert.isNotNull(json(bucket, "runs/cron-2026-11-14T06.json").finishedAt)
      assert.strictEqual(
        summaryOf(bucket, "runs/cron-2026-11-14T06.json").outcome,
        "failed"
      )
      assert.notInclude(bucket.puts, "runs/latest.json")
      assert.deepStrictEqual(keysUnder(bucket, "reports/"), [])
    })
  )

  it.effect(
    "fails without retrying when the listing's shape changed, and says so",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx()
        const bucket = memoryBucket()
        idx.listingResponse = () =>
          Response.json({ data: [{ Title: "Pemegang Saham di Atas 5%" }] })

        const failure = yield* Effect.flip(
          run(idx, bucket, "cron-2026-11-14T06")
        )

        assert.strictEqual(idx.requests.length, 1)
        assert.include(failure.message, "listing")
        assert.deepInclude(json(bucket, "runs/cron-2026-11-14T06.json"), {
          outcome: "failed",
          error: failure.message,
        })
      })
  )

  it.effect(
    "records the start of a long error, up to its most characters",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const steps = localSteps(Layer.merge(fakeIdx().layer, bucket.layer))
        // The runtime's message for a failed step, which it decides the size of.
        const message = `plan failed: ${"x".repeat(5 * MAX_RUN_ERROR_LENGTH)}`

        const failure = yield* Effect.flip(
          archiveRun(
            {
              do: (name, effect) =>
                name === "plan"
                  ? Effect.fail(new StepFailed({ step: name, message }))
                  : steps.do(name, effect),
            },
            {
              id: ArchiveRunId.make("cron-2026-11-14T06"),
              trigger: "cron",
              startedAt: new Date("2026-11-14T06:00:00Z"),
            }
          )
        )

        assert.strictEqual(failure.message, message)
        const { outcome, error } = json(bucket, "runs/cron-2026-11-14T06.json")
        assert.strictEqual(outcome, "failed")
        assert.strictEqual(
          error,
          `${message.slice(0, MAX_RUN_ERROR_LENGTH - 1)}…`
        )
      })
  )
})

describe("an archive run at the largest size it accepts", () => {
  const dataDate = "2026-11-13"

  // A report of an unknown kind whose ListedReport takes `bytes` as JSON.
  const listedAt = (index: number, bytes: number) => {
    const sourceUrl = `https://www.idx.co.id/Media/${String(index).padStart(8, "0")}/kelompok-${index}.xlsx`
    const listedBytes = (description: string, rawDescription: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          description,
          rawDescription,
          kind: "other",
          dataDate,
          sourceUrl,
          fetchUrl: idxIdUrl(sourceUrl),
        })
      ).length
    const base = `Laporan ${index}`
    // The description is listed twice, trimmed and raw; a trailing space
    // adds a byte to the raw one alone.
    const padding = bytes - listedBytes(base, base)
    const description = base + "x".repeat(Math.floor(padding / 2))
    const rawDescription = padding % 2 === 0 ? description : `${description} `
    assert.strictEqual(listedBytes(description, rawDescription), bytes)
    return {
      Description: rawDescription,
      Prospectus: sourceUrl,
      ListingDate: `${dataDate}T12:00:00`,
    }
  }

  const listing = (count: number, bytes = MAX_LISTED_REPORT_BYTES) =>
    Array.from({ length: count }, (_, index) => listedAt(index, bytes))

  // An ETag that takes `bytes` as JSON, quotes escaped.
  const etagAt = (index: number, bytes: number) =>
    `"${String(index).padEnd(bytes - 6, "1")}"`

  it.effect(
    "keeps every step's result under the step limit, first run and after",
    () =>
      Effect.gen(function* () {
        const idx = fakeIdx(listing(MAX_LISTED_REPORTS))
        const bucket = memoryBucket()

        // Everything is fresh, and `summary` lists every report as other.
        const first = yield* run(idx, bucket, "cron-2026-11-14T06")
        assert.deepInclude(first, {
          outcome: "complete",
          reportsAdded: MAX_LISTED_REPORTS,
        })
        assert.strictEqual(first.other.length, MAX_LISTED_REPORTS)

        // Every held URL now serves a new ETag of the most bytes a run
        // keeps, so `head` lists every one as changed.
        let index = 0
        for (const [url, file] of idx.files)
          idx.files.set(url, {
            ...file,
            etag: etagAt(index++, MAX_ETAG_BYTES),
          })
        const second = yield* run(idx, bucket, "cron-2026-11-14T13")
        assert.deepInclude(second, {
          outcome: "complete",
          reportsAdded: 0,
          newVersions: 0,
          reportsChecked: MAX_LISTED_REPORTS,
        })
        assert.strictEqual(
          bucket.puts.filter(
            (key) => key.startsWith("reports/") && key.endsWith(".json")
          ).length,
          2 * MAX_LISTED_REPORTS
        )
      }),
    120_000
  )

  it.effect("fails without retrying past the most reports a run holds", () =>
    Effect.gen(function* () {
      const idx = fakeIdx(listing(MAX_LISTED_REPORTS + 1, 300))
      const bucket = memoryBucket()

      const failure = yield* Effect.flip(run(idx, bucket, "cron-2026-11-14T06"))

      assert.strictEqual(idx.requests.length, 1)
      assert.include(failure.message, `more than the ${MAX_LISTED_REPORTS}`)
      assert.deepInclude(json(bucket, "runs/cron-2026-11-14T06.json"), {
        outcome: "failed",
        error: failure.message,
      })
      assert.deepStrictEqual(keysUnder(bucket, "reports/"), [])
    })
  )

  it.effect("reads a listing of the most bytes, and fails past it", () =>
    Effect.gen(function* () {
      // A listing that takes `bytes`, padded past its items.
      const listingOf = (bytes: number) => {
        const items = listing(2, 300)
        const base = JSON.stringify({ items, pad: "" })
        return JSON.stringify({ items, pad: "x".repeat(bytes - base.length) })
      }
      const atCap = fakeIdx(listing(2, 300))
      atCap.listingResponse = () => new Response(listingOf(MAX_LISTING_BYTES))
      const stored = yield* run(atCap, memoryBucket(), "cron-2026-11-14T06")
      assert.deepInclude(stored, { outcome: "complete", reportsAdded: 2 })

      const pastCap = fakeIdx(listing(2, 300))
      pastCap.listingResponse = () =>
        new Response(listingOf(MAX_LISTING_BYTES + 1))
      const bucket = memoryBucket()
      const failure = yield* Effect.flip(
        run(pastCap, bucket, "cron-2026-11-14T06")
      )
      assert.strictEqual(pastCap.requests.length, 1)
      assert.include(failure.message, `over ${MAX_LISTING_BYTES} bytes`)
      assert.deepInclude(json(bucket, "runs/cron-2026-11-14T06.json"), {
        outcome: "failed",
        error: failure.message,
      })
    })
  )

  it.effect("fails without retrying on a report past the most bytes", () =>
    Effect.gen(function* () {
      const idx = fakeIdx([
        listedAt(0, MAX_LISTED_REPORT_BYTES),
        listedAt(1, MAX_LISTED_REPORT_BYTES + 1),
      ])
      const bucket = memoryBucket()

      const failure = yield* Effect.flip(run(idx, bucket, "cron-2026-11-14T06"))

      assert.strictEqual(idx.requests.length, 1)
      assert.include(failure.message, "kelompok-1.xlsx")
      assert.deepInclude(json(bucket, "runs/cron-2026-11-14T06.json"), {
        outcome: "failed",
        error: failure.message,
      })
    })
  )

  it.effect("stores reports whose URLs differ only past 250 characters", () =>
    Effect.gen(function* () {
      const longUrl = (last: string) => {
        const head = "https://www.idx.co.id/Media/"
        return `${head}${"p".repeat(252 - head.length - 6)}${last}.xlsx`
      }
      const urls = [longUrl("a"), longUrl("b")]
      assert.deepStrictEqual(
        urls.map((url) => url.length),
        [252, 252]
      )
      const idx = fakeIdx(
        urls.map((Prospectus) => ({
          Description: "Laporan x",
          Prospectus,
          ListingDate: `${dataDate}T12:00:00`,
        }))
      )
      const bucket = memoryBucket()

      const result = yield* run(idx, bucket, "cron-2026-11-14T06")

      assert.deepInclude(result, { outcome: "complete", reportsAdded: 2 })
      for (const url of urls)
        assert.strictEqual(recordsOf(bucket, url).length, 1)
    })
  )

  it.effect("leaves a URL not stored while its HEAD ETag is too long", () =>
    Effect.gen(function* () {
      const idx = fakeIdx(listing(2))
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")
      const [atCap, pastCap] = idx.listing.map(({ Prospectus }) => Prospectus)
      for (const [url, bytes] of [
        [atCap, MAX_ETAG_BYTES],
        [pastCap, MAX_ETAG_BYTES + 1],
      ] as const) {
        const file = idx.files.get(idxIdUrl(url))
        assert.isDefined(file)
        idx.files.set(idxIdUrl(url), { ...file, etag: etagAt(0, bytes) })
      }

      const result = yield* run(idx, bucket, "cron-2026-11-14T13")

      assert.deepInclude(result, {
        outcome: "partial",
        reportsChecked: 1,
        notStored: [pastCap],
      })
      assert.strictEqual(recordsOf(bucket, atCap).length, 2)
      assert.strictEqual(recordsOf(bucket, pastCap).length, 1)
    })
  )
})
