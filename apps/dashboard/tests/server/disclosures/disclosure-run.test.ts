import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { RunId } from "@/server/archive/run"
import { disclosureRun, FILES_PER_RUN } from "@/server/disclosures/archive-run"
import {
  MAX_KEY_LENGTH,
  MAX_PATH_LENGTH,
  PAGE_SIZE,
} from "@/server/disclosures/listing"

import { localSteps } from "../archive/local-steps.ts"
import { memoryArchiveDb } from "../archive/memory-archive-db.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import { storedRun } from "../archive/runs.ts"
import {
  bodyOf,
  type FakeIdx,
  fakeIdx,
  fileRequests,
  keyOf,
  pathOf,
  publish,
  type Published,
  publishRecorded,
  RECORDED,
  replyOf,
} from "./fake-idx.ts"

const DISCLOSURE_RUN = { archive: "disclosure", runKind: "archive" } as const

// 10:00 WIB on 26 November 2026: the run lists 20 to 26 November.
const NOW = new Date("2026-11-26T03:00:00Z")

const world = () => {
  const idx = fakeIdx()
  const bucket = memoryBucket()
  const db = memoryArchiveDb()
  let runs = 0
  const run = (startedAt = NOW, layer = idx.layer) =>
    disclosureRun(localSteps(Layer.mergeAll(layer, bucket.layer, db.layer)), {
      id: RunId.make(`admin-${startedAt.getTime() + runs++}`),
      trigger: "admin",
      startedAt,
    })
  return { idx, bucket, db, run }
}

const NAV: Published = {
  stamp: "20261124230949",
  number: "02894/FMS/OPS-BTIM/XI/26",
  files: ["nav.pdf", "nav_lamp1.pdf"],
}

const encoded = (published: Published) =>
  `disclosures/${encodeURIComponent(keyOf(published))}`

const keysOf = (bucket: MemoryBucket, published: Published) =>
  [...bucket.objects.keys()]
    .filter((key) => key.startsWith(`${encoded(published)}/`))
    .sort()

const json = (bucket: MemoryBucket, key: string) =>
  JSON.parse(bucket.objects.get(key)?.body ?? "null")

const filesOf = (idx: FakeIdx) => fileRequests(idx).sort()

describe("a disclosure run", () => {
  it.effect(
    "stores both versions of a disclosure and their attachments under its key",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        publish(idx, NAV)

        const result = yield* run()

        assert.deepStrictEqual(keysOf(bucket, NAV), [
          `${encoded(NAV)}/en.json`,
          `${encoded(NAV)}/files${pathOf("nav.pdf")}`,
          `${encoded(NAV)}/files${pathOf("nav_lamp1.pdf")}`,
          `${encoded(NAV)}/id.json`,
        ])
        // Each version as IDX listed it.
        assert.deepStrictEqual(
          json(bucket, `${encoded(NAV)}/id.json`),
          replyOf(NAV, "id")
        )
        assert.deepStrictEqual(
          json(bucket, `${encoded(NAV)}/en.json`),
          replyOf(NAV, "en")
        )
        assert.strictEqual(
          bucket.objects.get(`${encoded(NAV)}/files${pathOf("nav.pdf")}`)?.body,
          bodyOf(pathOf("nav.pdf"))
        )
        // Both versions list both files: each is downloaded once.
        assert.deepStrictEqual(filesOf(idx), [
          pathOf("nav.pdf"),
          pathOf("nav_lamp1.pdf"),
        ])
        assert.deepInclude(result, {
          outcome: "complete",
          versionsAdded: 2,
          attachmentsStored: 2,
          attachmentsWaiting: 0,
          notStored: [],
        })
        assert.deepStrictEqual(result.days, [
          "2026-11-26",
          "2026-11-25",
          "2026-11-24",
          "2026-11-23",
          "2026-11-22",
          "2026-11-21",
          "2026-11-20",
        ])
      })
  )

  it.effect("reads only www.idx.id", () =>
    Effect.gen(function* () {
      const { idx, run } = world()
      publish(idx, NAV)
      yield* run()
      assert.isNotEmpty(idx.requests)
      for (const url of idx.requests)
        assert.strictEqual(new URL(url).host, "www.idx.id")
    })
  )

  it.effect("records its result in ArchiveDb", () =>
    Effect.gen(function* () {
      const { idx, db, run } = world()
      publish(idx, NAV)
      const result = yield* run()
      assert.deepStrictEqual(
        storedRun(db, DISCLOSURE_RUN, result.id),
        JSON.parse(JSON.stringify(result))
      )
    })
  )

  it.effect(
    "stores a version listed later, inside the 7 days, without fetching its files again",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        publish(idx, NAV, ["id"])
        const first = yield* run()
        assert.deepInclude(first, { versionsAdded: 1, attachmentsStored: 2 })
        assert.notInclude(keysOf(bucket, NAV), `${encoded(NAV)}/en.json`)

        // IDX adds the English version two days later.
        idx.versions.en.push(replyOf(NAV, "en"))
        idx.requests.length = 0
        const later = yield* run(new Date("2026-11-28T03:00:00Z"))

        assert.deepStrictEqual(
          json(bucket, `${encoded(NAV)}/en.json`),
          replyOf(NAV, "en")
        )
        assert.deepInclude(later, {
          outcome: "complete",
          versionsAdded: 1,
          attachmentsStored: 0,
        })
        assert.deepStrictEqual(fileRequests(idx), [])
      })
  )

  it.effect("stores a file only one version lists under the same key", () =>
    Effect.gen(function* () {
      const { idx, bucket, run } = world()
      publish(idx, NAV, ["id"])
      publish(idx, { ...NAV, files: ["nav.pdf", "nav_en.pdf"] }, ["en"])

      const result = yield* run()

      assert.deepInclude(result, { versionsAdded: 2, attachmentsStored: 3 })
      assert.deepStrictEqual(
        keysOf(bucket, NAV).filter((key) => key.includes("/files/")),
        [
          `${encoded(NAV)}/files${pathOf("nav.pdf")}`,
          `${encoded(NAV)}/files${pathOf("nav_en.pdf")}`,
          `${encoded(NAV)}/files${pathOf("nav_lamp1.pdf")}`,
        ]
      )
    })
  )

  it.effect("downloads nothing again on a second run over the same days", () =>
    Effect.gen(function* () {
      const { idx, bucket, run } = world()
      publish(idx, NAV)
      yield* run()
      idx.requests.length = 0
      const puts = bucket.puts.length

      const second = yield* run()

      assert.deepStrictEqual(fileRequests(idx), [])
      assert.strictEqual(bucket.puts.length, puts)
      assert.deepInclude(second, {
        outcome: "complete",
        versionsAdded: 0,
        attachmentsStored: 0,
      })
    })
  )

  it.effect("never rewrites a stored version IDX later lists differently", () =>
    Effect.gen(function* () {
      const { idx, bucket, run } = world()
      publish(idx, NAV)
      yield* run()
      idx.versions.id.splice(
        0,
        1,
        replyOf({ ...NAV, title: "Laporan Bulanan (ralat)" }, "id")
      )

      yield* run()

      assert.deepStrictEqual(
        json(bucket, `${encoded(NAV)}/id.json`),
        replyOf(NAV, "id")
      )
    })
  )

  it.effect("keeps every disclosure of the 7 days, and none outside them", () =>
    Effect.gen(function* () {
      const { idx, bucket, run } = world()
      const oldest = { ...NAV, stamp: "20261120080000", number: "A/1" }
      const tooOld = { ...NAV, stamp: "20261119235959", number: "A/2" }
      const broker = { ...NAV, stamp: "20261126090000", number: "B/3" }
      for (const published of [oldest, tooOld, broker]) publish(idx, published)

      const result = yield* run()

      assert.strictEqual(result.versionsAdded, 4)
      assert.isNotEmpty(keysOf(bucket, oldest))
      assert.isNotEmpty(keysOf(bucket, broker))
      assert.isEmpty(keysOf(bucket, tooOld))
    })
  )

  it.effect(
    "leaves the run partial when a file fails, and stores it on a later run",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        publish(idx, NAV)
        idx.files.set(pathOf("nav_lamp1.pdf"), { body: "", status: 503 })

        const first = yield* run()

        assert.deepInclude(first, {
          outcome: "partial",
          attachmentsStored: 1,
          attachmentsWaiting: 1,
        })
        assert.deepStrictEqual(first.notStored, [
          {
            disclosure: keyOf(NAV),
            path: pathOf("nav_lamp1.pdf"),
            message: "IDX answered 503",
          },
        ])
        assert.notInclude(
          keysOf(bucket, NAV),
          `${encoded(NAV)}/files${pathOf("nav_lamp1.pdf")}`
        )

        idx.files.set(pathOf("nav_lamp1.pdf"), {
          body: bodyOf(pathOf("nav_lamp1.pdf")),
        })
        idx.requests.length = 0
        const later = yield* run()

        assert.deepInclude(later, {
          outcome: "complete",
          attachmentsStored: 1,
          attachmentsWaiting: 0,
          notStored: [],
        })
        assert.deepStrictEqual(fileRequests(idx), [pathOf("nav_lamp1.pdf")])
        assert.include(
          keysOf(bucket, NAV),
          `${encoded(NAV)}/files${pathOf("nav_lamp1.pdf")}`
        )
      })
  )

  it.effect("fails with IDX's answer when a listing can't be read", () =>
    Effect.gen(function* () {
      const { idx, db, run } = world()
      publish(idx, NAV)
      idx.listingResponse = () => new Response("busy", { status: 500 })

      const failed = yield* Effect.flip(run())

      assert.strictEqual(failed._tag, "StepFailed")
      const [row] = db.database
        .prepare("SELECT record FROM run WHERE archive = 'disclosure'")
        .all() as Array<{ record: string }>
      const record = JSON.parse(row?.record ?? "null")
      assert.strictEqual(record.outcome, "failed")
      assert.match(
        record.error,
        /^IDX's disclosures of 2026-11-26 \(id\) answered 500 \(https:\/\/www\.idx\.id\/primary\/ListedCompany\/GetAnnouncement\?/
      )
      assert.deepStrictEqual(fileRequests(idx), [])
    })
  )

  it.effect("fails when IDX's listing changes shape", () =>
    Effect.gen(function* () {
      const { idx, db, run } = world()
      idx.listingResponse = () => Response.json({ Results: [] })

      yield* Effect.flip(run())

      const [row] = db.database
        .prepare("SELECT record FROM run WHERE archive = 'disclosure'")
        .all() as Array<{ record: string }>
      assert.match(
        JSON.parse(row?.record ?? "null").error,
        /^IDX's disclosures no longer match their Schema/
      )
    })
  )

  it.effect("reads a day IDX lists on more than one page", () =>
    Effect.gen(function* () {
      const { idx, run } = world()
      for (let n = 0; n < PAGE_SIZE + 1; n++)
        publish(idx, { stamp: "20261125100000", number: `P/${n}`, files: [] }, [
          "id",
        ])

      const result = yield* run()

      assert.strictEqual(result.versionsAdded, PAGE_SIZE + 1)
    })
  )

  it.effect(
    "stores at most FILES_PER_RUN files a run, the longest keys and paths fitting its steps",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        // Each disclosure's key and its file's path at their longest.
        const number = "N".repeat(MAX_KEY_LENGTH - "20261125100000-".length - 5)
        for (let n = 0; n < FILES_PER_RUN + 1; n++) {
          const file = `${String(n).padStart(5, "0")}${"f".repeat(MAX_PATH_LENGTH - pathOf("").length - 5)}`
          publish(
            idx,
            {
              stamp: "20261125100000",
              number: `${number}${String(n).padStart(5, "0")}`,
              files: [file],
            },
            ["id"]
          )
        }

        const first = yield* run()

        assert.deepInclude(first, {
          outcome: "partial",
          attachmentsStored: FILES_PER_RUN,
          attachmentsWaiting: 1,
          notStored: [],
        })
        const second = yield* run()
        assert.deepInclude(second, {
          outcome: "complete",
          attachmentsStored: 1,
          attachmentsWaiting: 0,
        })
      }),
    { timeout: 30_000 }
  )

  it.effect("keys IDX's recorded disclosures by Id2 without the language", () =>
    Effect.gen(function* () {
      const { idx, bucket, run } = world()
      publishRecorded(idx)

      const result = yield* run()

      assert.deepInclude(result, {
        outcome: "complete",
        versionsAdded: 4,
        attachmentsStored: 6,
      })
      const key = encodeURIComponent("20261124230949-02894/FMS/OPS-BTIM/XI/26")
      assert.deepStrictEqual(
        json(bucket, `disclosures/${key}/en.json`),
        RECORDED.en[0]
      )
      assert.include(
        [...bucket.objects.keys()],
        `disclosures/${key}/files/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/From_EREP/202611/20261124_XPIN_E043_8373aead-8253-4c24-92de-b06baecb9c30_lamp2-20261124230953.pdf`
      )
    })
  )
})
