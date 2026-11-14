import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { archiveRun } from "@/server/shareholding/archive-run"

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
    id,
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
        id: "cron-2026-11-14T13",
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
      assert.deepStrictEqual(json(bucket, "runs/latest.json"), {
        id: "cron-2026-11-14T13",
      })
    })
  )

  it.effect("stores nothing new when nothing changed", () =>
    Effect.gen(function* () {
      const idx = fakeIdx()
      const bucket = memoryBucket()
      yield* run(idx, bucket, "cron-2026-11-14T06")
      const before = keysUnder(bucket, "reports/")
      bucket.puts.length = 0

      const result = yield* run(
        idx,
        bucket,
        "cron-2026-11-14T13",
        new Date("2026-11-14T13:00:00Z")
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
      })
      assert.deepStrictEqual(json(bucket, "runs/latest.json"), {
        id: "cron-2026-11-14T13",
      })
      assert.strictEqual(
        json(bucket, "runs/cron-2026-11-14T06.json").outcome,
        "complete"
      )
    })
  )
})
