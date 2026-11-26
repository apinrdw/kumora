import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { FIRST_DISCLOSURE_DAY } from "@/server/disclosures/disclosure-day"
import { disclosureRun, FILES_PER_RUN } from "@/server/disclosures/archive-run"
import { DisclosureKey } from "@/server/disclosures/key"
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
import { seedHistory } from "./seed-history.ts"

const DISCLOSURE_RUN = { archive: "disclosure", runKind: "archive" } as const

// 10:00 WIB on 26 November 2026: the run lists 20 to 26 November.
const NOW = new Date("2026-11-26T03:00:00Z")

const world = () => {
  const idx = fakeIdx()
  const bucket = memoryBucket()
  const db = memoryArchiveDb()
  let runs = 0
  // The clock reads the run's start, as a run's steps read it.
  const run = (startedAt = NOW, layer = idx.layer) =>
    TestClock.setTime(startedAt.getTime()).pipe(
      Effect.andThen(
        disclosureRun(
          localSteps(Layer.mergeAll(layer, bucket.layer, db.layer)),
          {
            id: RunId.make(`admin-${startedAt.getTime() + runs++}`),
            trigger: "admin",
            startedAt,
          }
        )
      )
    )
  return { idx, bucket, db, run }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60_000

const NAV: Published = {
  stamp: "20261124230949",
  number: "02894/FMS/OPS-BTIM/XI/26",
  files: ["nav.pdf", "nav_lamp1.pdf"],
}

// IDX's first disclosure, on its first disclosure day.
const FIRST: Published = {
  stamp: "20230703081455",
  number: "092/KIC-CS/VII/2023",
  files: ["a.pdf"],
}

// The days the test's runs listed, YYYYMMDD, each once, in order.
const listedDates = (idx: FakeIdx) => [
  ...new Set(
    idx.requests
      .map((url) => new URL(url))
      .filter((url) => url.pathname.endsWith("/GetAnnouncement"))
      .map((url) => url.searchParams.get("dateFrom") ?? "")
  ),
]

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
          WibDate.make("2026-11-26"),
          WibDate.make("2026-11-25"),
          WibDate.make("2026-11-24"),
          WibDate.make("2026-11-23"),
          WibDate.make("2026-11-22"),
          WibDate.make("2026-11-21"),
          WibDate.make("2026-11-20"),
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
            disclosure: DisclosureKey.make(keyOf(NAV)),
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

  it.effect(
    "stores a file however large IDX serves it",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        publish(idx, NAV)
        const large = "%PDF-1.4 ".padEnd(48 * 1024 * 1024, "x")
        idx.files.set(pathOf("nav_lamp1.pdf"), { body: large })

        const result = yield* run()

        assert.deepInclude(result, {
          outcome: "complete",
          attachmentsStored: 2,
          notStored: [],
        })
        assert.strictEqual(
          bucket.objects.get(`${encoded(NAV)}/files${pathOf("nav_lamp1.pdf")}`)
            ?.bytes?.length,
          large.length
        )
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "retries a failing file each run while its failures span less than 7 days",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        publish(idx, FIRST)
        idx.files.set(pathOf("a.pdf"), { body: "", status: 404 })

        const first = yield* run()
        idx.requests.length = 0
        const later = yield* run(new Date(NOW.getTime() + SEVEN_DAYS - 1000))

        for (const result of [first, later])
          assert.deepInclude(result, {
            outcome: "partial",
            attachmentsWaiting: 1,
          })
        assert.strictEqual(later.backfillDays[0], FIRST_DISCLOSURE_DAY)
        assert.deepStrictEqual(fileRequests(idx), [pathOf("a.pdf")])
      })
  )

  it.effect(
    "stops retrying a file once its failures span 7 days, and completes its day",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        publish(idx, FIRST)
        idx.files.set(pathOf("a.pdf"), { body: "", status: 404 })

        yield* run()
        const marking = yield* run(new Date(NOW.getTime() + SEVEN_DAYS))
        assert.deepInclude(marking, { attachmentsWaiting: 0 })
        idx.requests.length = 0

        const after = yield* run(
          new Date(NOW.getTime() + SEVEN_DAYS + 15 * 60_000)
        )

        assert.deepStrictEqual(fileRequests(idx), [])
        assert.notInclude(after.backfillDays, FIRST_DISCLOSURE_DAY)
        assert.notInclude(listedDates(idx), "20230703")
      })
  )

  it.effect(
    "leaves no failure recorded against a file that downloads before 7 days",
    () =>
      Effect.gen(function* () {
        const { idx, db, run } = world()
        publish(idx, FIRST)
        idx.files.set(pathOf("a.pdf"), { body: "", status: 503 })
        yield* run()

        idx.files.set(pathOf("a.pdf"), { body: bodyOf(pathOf("a.pdf")) })
        const later = yield* run(new Date(NOW.getTime() + SEVEN_DAYS - 1000))

        assert.deepInclude(later, { attachmentsWaiting: 0 })
        assert.deepStrictEqual(
          db.database
            .prepare(
              "SELECT stored_at IS NOT NULL AS stored, first_failed_at, " +
                "last_error, unavailable_at FROM disclosure_attachment"
            )
            .all(),
          [
            {
              stored: 1,
              first_failed_at: null,
              last_error: null,
              unavailable_at: null,
            },
          ]
        )
      })
  )

  it.effect(
    "indexes a file its bucket holds without asking IDX again, when indexing it failed",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, db, run } = world()
        publish(idx, FIRST)
        // The file is in the bucket, then its index row fails to say so,
        // and IDX no longer serves it when the step is retried.
        db.failBatch = (sql) => {
          if (!sql.some((each) => each.includes("SET stored_at"))) return false
          db.failBatch = undefined
          idx.files.set(pathOf("a.pdf"), { body: "", status: 404 })
          return true
        }

        const result = yield* run()

        assert.deepInclude(result, {
          outcome: "complete",
          attachmentsStored: 1,
          attachmentsWaiting: 0,
          notStored: [],
        })
        assert.deepStrictEqual(fileRequests(idx), [pathOf("a.pdf")])
        assert.deepStrictEqual(
          db.database
            .prepare("SELECT bytes, first_failed_at FROM disclosure_attachment")
            .all(),
          [
            {
              bytes: bodyOf(pathOf("a.pdf")).length,
              first_failed_at: null,
            },
          ]
        )
        assert.strictEqual(
          bucket.objects.get(`${encoded(FIRST)}/files${pathOf("a.pdf")}`)?.body,
          bodyOf(pathOf("a.pdf"))
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

  it.effect(
    "skips a malformed entry, records it on the run, and stores the rest of its day",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        publish(idx, NAV)
        // An Id2 without its language suffix.
        const unkeyed = replyOf(
          { stamp: "20261125100000", number: "U/1", files: [] },
          "id"
        )
        idx.versions.id.push({
          ...unkeyed,
          pengumuman: { ...unkeyed.pengumuman, Id2: "20261125100000-U/1" },
        })
        // An attachment whose FullSavePath isn't a URL, beside one that is.
        const badPath: Published = {
          stamp: "20261125110000",
          number: "B/1",
          files: ["ok.pdf"],
        }
        publish(idx, badPath, ["id"])
        const [listed] = idx.versions.id.slice(-1)
        if (listed === undefined) return assert.fail("no reply")
        idx.versions.id[idx.versions.id.length - 1] = {
          ...listed,
          attachments: [...listed.attachments, { FullSavePath: "not a url" }],
        }
        // A reply far larger than IDX's usual ~3.5 KB.
        const long: Published = {
          stamp: "20261125120000",
          number: "L/1",
          files: [],
          title: "x".repeat(64 * 1024),
        }
        publish(idx, long, ["id"])

        const result = yield* run()

        assert.deepInclude(result, {
          outcome: "partial",
          versionsAdded: 4,
          attachmentsStored: 3,
          attachmentsWaiting: 0,
          entriesSkipped: 2,
        })
        assert.deepStrictEqual(result.skipped, [
          "IDX listed a disclosure on 2026-11-25 (id) whose Id2 isn't a publish time and number: 20261125100000-U/1",
          `IDX listed disclosure ${keyOf(badPath)} (id) with an attachment at not a url, not a URL of at most ${MAX_PATH_LENGTH} characters`,
        ])
        assert.deepStrictEqual(keysOf(bucket, badPath), [
          `${encoded(badPath)}/files${pathOf("ok.pdf")}`,
          `${encoded(badPath)}/id.json`,
        ])
        assert.deepStrictEqual(
          json(bucket, `${encoded(long)}/id.json`),
          replyOf(long, "id")
        )
        assert.isNotEmpty(keysOf(bucket, NAV))
      })
  )

  it.effect("skips a disclosure whose Id2 names a day the calendar lacks", () =>
    Effect.gen(function* () {
      const { idx, run } = world()
      publish(idx, NAV)
      const reply = replyOf(
        { stamp: "20261125100000", number: "F/30", files: [] },
        "id"
      )
      idx.versions.id.push({
        ...reply,
        pengumuman: { ...reply.pengumuman, Id2: "20260230100000-F/30_id-id" },
      })

      const result = yield* run()

      assert.deepInclude(result, {
        outcome: "partial",
        versionsAdded: 2,
        entriesSkipped: 1,
      })
      assert.deepStrictEqual(result.skipped, [
        "IDX listed a disclosure on 2026-11-25 (id) whose Id2 isn't a publish time and number: 20260230100000-F/30_id-id",
      ])
    })
  )

  it.effect(
    "completes a backfilled day despite a malformed entry, and never lists it again",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        publish(idx, FIRST)
        const unkeyed = replyOf(
          { stamp: "20230703100000", number: "U/1", files: [] },
          "en"
        )
        idx.versions.en.push({
          ...unkeyed,
          pengumuman: { ...unkeyed.pengumuman, Id2: "not an id" },
        })

        const first = yield* run()
        assert.deepInclude(first, { outcome: "partial", entriesSkipped: 1 })
        idx.requests.length = 0

        const second = yield* run()

        assert.notInclude(second.backfillDays, FIRST_DISCLOSURE_DAY)
        assert.notInclude(listedDates(idx), "20230703")
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

  it.effect(
    "stores the 7 days first, then backfills from IDX's first disclosure day",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        const first = FIRST
        const second = {
          stamp: "20230704090000",
          number: "093/KIC",
          files: ["b.pdf"],
        }
        for (const published of [second, first, NAV]) publish(idx, published)

        const result = yield* run()

        assert.strictEqual(FIRST_DISCLOSURE_DAY, "2023-07-03")
        assert.deepStrictEqual(result.backfillDays.slice(0, 2), [
          "2023-07-03",
          "2023-07-04",
        ])
        assert.isNotEmpty(keysOf(bucket, first))
        assert.isNotEmpty(keysOf(bucket, second))
        // The 7 days' files first, then the oldest day's.
        assert.deepStrictEqual(fileRequests(idx), [
          pathOf("nav.pdf"),
          pathOf("nav_lamp1.pdf"),
          pathOf("a.pdf"),
          pathOf("b.pdf"),
        ])
        assert.deepInclude(result, { outcome: "complete", versionsAdded: 6 })
      })
  )

  it.effect(
    "never lists a complete day again, and takes up the next incomplete one",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        publish(idx, FIRST)

        const first = yield* run()
        assert.strictEqual(first.backfillDays.at(-1), "2023-08-02")
        idx.requests.length = 0

        const second = yield* run()

        assert.strictEqual(second.backfillDays[0], "2023-08-03")
        assert.deepStrictEqual(
          listedDates(idx).filter((day) => day < "2026"),
          second.backfillDays.map((day) => day.replaceAll("-", ""))
        )
      })
  )

  it.effect(
    "ends partial when its budget runs out, and the next run resumes the day without listing it",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        for (let n = 0; n < FILES_PER_RUN + 1; n++)
          publish(
            idx,
            { stamp: "20230703100000", number: `D/${n}`, files: [`d${n}.pdf`] },
            ["id"]
          )

        const first = yield* run()

        assert.deepInclude(first, {
          outcome: "partial",
          attachmentsStored: FILES_PER_RUN,
          attachmentsWaiting: 1,
          notStored: [],
        })
        assert.deepStrictEqual(first.backfillDays, [WibDate.make("2023-07-03")])
        idx.requests.length = 0

        const second = yield* run()

        assert.deepInclude(second, {
          outcome: "complete",
          attachmentsStored: 1,
          attachmentsWaiting: 0,
        })
        assert.strictEqual(second.backfillDays[0], "2023-07-03")
        assert.notInclude(listedDates(idx), "20230703")
        idx.requests.length = 0

        const third = yield* run()

        assert.strictEqual(third.backfillDays[0], "2023-08-03")
        assert.deepStrictEqual(fileRequests(idx), [])
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "backfills nothing while the 7 days fill the budget",
    () =>
      Effect.gen(function* () {
        const { idx, run } = world()
        publish(idx, FIRST)
        for (let n = 0; n < FILES_PER_RUN; n++)
          publish(
            idx,
            { stamp: "20261125100000", number: `R/${n}`, files: [`r${n}.pdf`] },
            ["id"]
          )

        const result = yield* run()

        assert.deepInclude(result, {
          outcome: "complete",
          attachmentsStored: FILES_PER_RUN,
        })
        assert.deepStrictEqual(result.backfillDays, [])
        assert.notInclude(listedDates(idx), "20230703")
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "takes up the oldest incomplete day of the whole history within its caps",
    () =>
      Effect.gen(function* () {
        const { idx, db, run } = world()
        seedHistory(db, "2026-11-16")
        // 15 November waits for 2,000 attachments: two runs' budget.
        db.database
          .prepare(
            "UPDATE disclosure_day SET complete_at = NULL WHERE day = '2026-11-15'"
          )
          .run()
        const insert = db.database.prepare(
          "INSERT INTO disclosure_attachment (disclosure_key, path, day, object_key) " +
            "VALUES ('20261115090000-W/1', ?, '2026-11-15', ?)"
        )
        for (let n = 0; n < 2 * FILES_PER_RUN; n++) {
          insert.run(pathOf(`w${n}.pdf`), `w/${n}`)
          idx.files.set(pathOf(`w${n}.pdf`), {
            body: bodyOf(pathOf(`w${n}.pdf`)),
          })
        }

        assert.deepStrictEqual(
          db.database
            .prepare(
              "SELECT (SELECT COUNT(*) FROM disclosure_version) AS versions, " +
                "(SELECT COUNT(*) FROM disclosure_attachment) AS attachments"
            )
            .get(),
          { versions: 538_000, attachments: 602_000 }
        )

        const result = yield* run()

        assert.deepStrictEqual(result.backfillDays, [
          WibDate.make("2026-11-15"),
        ])
        assert.deepInclude(result, {
          outcome: "partial",
          attachmentsStored: FILES_PER_RUN,
          attachmentsWaiting: FILES_PER_RUN,
        })
        // Neither the complete days nor the day it resumed are listed.
        assert.deepStrictEqual(
          listedDates(idx).filter((day) => day < "20261120"),
          []
        )
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "lists again a day it listed only before the day ended, once it is backfilled",
    () =>
      Effect.gen(function* () {
        const { idx, bucket, run } = world()
        // A run at 10:00 WIB on 3 July 2023 lists the day so far.
        yield* run(new Date("2023-07-03T03:00:00Z"))
        publish(idx, FIRST)

        // The next, long after.
        const later = yield* run()

        assert.strictEqual(later.backfillDays[0], "2023-07-03")
        assert.isNotEmpty(keysOf(bucket, FIRST))
      })
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
