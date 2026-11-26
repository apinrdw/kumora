import { assert, describe, it } from "@effect/vitest"
import { Conflict, jsonBytes, Unauthorized } from "@workspace/server"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import {
  disclosureArchivePage,
  runDisclosuresNow,
} from "@/server/admin/disclosures"
import type { Mail } from "@/server/auth/mailer"
import { RunId } from "@/server/archive/run"
import { MAX_COVERAGE_BYTES } from "@/server/disclosures/coverage"
import type { DisclosureRunResult } from "@/server/disclosures/run-result"

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
import { seedRun } from "../archive/runs.ts"
import { seedHistory } from "../disclosures/seed-history.ts"

const DISCLOSURE_RUN = { archive: "disclosure", runKind: "archive" } as const

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

const PARTIAL: DisclosureRunResult = {
  id: RunId.make("admin-1795662000000"),
  trigger: "admin",
  startedAt: "2026-11-26T03:00:00.000Z",
  finishedAt: "2026-11-26T03:04:00.000Z",
  outcome: "partial",
  days: ["2026-11-26"],
  backfillDays: ["2023-07-03"],
  versionsAdded: 380,
  attachmentsStored: 610,
  attachmentsWaiting: 1,
  notStored: [
    {
      disclosure: "20261126090000-B/3",
      path: "/StaticData/x.pdf",
      message: "IDX answered 503",
    },
  ],
  error: null,
}

const archive = () => {
  const auth = seam()
  const db = memoryArchiveDb()
  const workflow = fakeWorkflow()
  return {
    ...auth,
    db,
    workflow,
    layer: Layer.mergeAll(
      auth.layer,
      memoryBucket().layer,
      db.layer,
      workflow.layer
    ),
  }
}

const createdIds = (workflow: FakeWorkflow) => [...workflow.instances.keys()]

// A disclosure day a run listed after it ended, complete or not.
const seedDay = (
  db: MemoryArchiveDb,
  day: string,
  { complete }: { readonly complete: boolean }
) =>
  db.database
    .prepare(
      "INSERT INTO disclosure_day (day, listed_at, complete_at) VALUES (?, ?, ?)"
    )
    .run(day, `${day}T20:00:00.000Z`, complete ? `${day}T20:00:00.000Z` : null)

// An attachment of `disclosure`'s Indonesian version, stored or waiting.
const seedAttachment = (
  db: MemoryArchiveDb,
  disclosure: string,
  path: string,
  { stored }: { readonly stored: boolean }
) => {
  const day = `${disclosure.slice(0, 4)}-${disclosure.slice(4, 6)}-${disclosure.slice(6, 8)}`
  db.database
    .prepare(
      "INSERT OR IGNORE INTO disclosure_version " +
        "(disclosure_key, language, day, object_key, stored_at) VALUES (?, 'id', ?, ?, ?)"
    )
    .run(
      disclosure,
      day,
      `disclosures/${disclosure}/id.json`,
      `${day}T20:00:00.000Z`
    )
  db.database
    .prepare(
      "INSERT INTO disclosure_attachment (disclosure_key, path, day, object_key, stored_at) " +
        "VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      disclosure,
      path,
      day,
      `disclosures/${disclosure}/files${path}`,
      stored ? `${day}T20:00:00.000Z` : null
    )
}

describe("the Disclosures admin page", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = archive()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(disclosureArchivePage(headers()))
      assert.deepStrictEqual(
        error,
        new Unauthorized({
          redirectTo: "/sign-in?redirect=%2Fadmin%2Fdisclosures",
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member, and starts no run for one", () => {
    const { layer, mails, workflow } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const page = yield* Effect.flip(disclosureArchivePage(headers(cookie)))
      assert.strictEqual(page._tag, "NotFound")
      const run = yield* Effect.flip(runDisclosuresNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      assert.deepStrictEqual(createdIds(workflow), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin no run yet", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* TestClock.setTime(Date.parse("2026-11-26T03:07:00.000Z"))
      const page = yield* disclosureArchivePage(headers(cookie))
      assert.isUndefined(page.lastRun)
      // The cron's next quarter hour.
      assert.strictEqual(page.nextRun, "2026-11-26T03:15:00.000Z")
      assert.deepStrictEqual(page.recentRuns, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows the last run and the run history", () => {
    const { layer, mails, db } = archive()
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-26T04:00:00.000Z"))
      seedRun(db, DISCLOSURE_RUN, PARTIAL, { latest: true })
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* disclosureArchivePage(headers(cookie))
      assert.deepStrictEqual(page.lastRun?.result, PARTIAL)
      assert.deepStrictEqual(page.recentRuns, [
        {
          id: PARTIAL.id,
          trigger: "admin",
          startedAt: PARTIAL.startedAt,
          outcome: "partial",
          versionsAdded: 380,
          attachmentsStored: 610,
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "shows each day's coverage from IDX's first disclosure day, and the earliest day held",
    () => {
      const { layer, mails, db } = archive()
      return Effect.gen(function* () {
        // 11:00 WIB on 5 July 2023.
        yield* TestClock.setTime(Date.parse("2023-07-05T04:00:00.000Z"))
        seedDay(db, "2023-07-03", { complete: true })
        seedDay(db, "2023-07-04", { complete: false })
        seedAttachment(db, "20230704090000-A/1", "/a.pdf", { stored: true })
        seedAttachment(db, "20230704090000-A/1", "/b.pdf", { stored: false })
        seedAttachment(db, "20230704090000-A/1", "/c.pdf", { stored: false })
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")

        const page = yield* disclosureArchivePage(headers(cookie))

        assert.deepStrictEqual(page.coverage, {
          earliestDay: "2023-07-04",
          complete: 1,
          incomplete: 1,
          notListed: 1,
          months: [
            {
              month: "2023-07",
              days: [
                null,
                null,
                { date: "2023-07-03", state: "complete", waiting: 0 },
                { date: "2023-07-04", state: "incomplete", waiting: 2 },
                { date: "2023-07-05", state: "not-listed", waiting: 0 },
              ],
            },
          ],
        })
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "keeps the whole history's coverage within its stated size",
    () => {
      const { layer, mails, db } = archive()
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-26T04:00:00.000Z"))
        seedHistory(db, "2026-11-25")
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")

        const { coverage } = yield* disclosureArchivePage(headers(cookie))

        assert.deepInclude(coverage, {
          earliestDay: "2023-07-03",
          complete: 1242,
          incomplete: 0,
          notListed: 1,
        })
        assert.isAtMost(yield* jsonBytes(coverage), MAX_COVERAGE_BYTES)
      }).pipe(Effect.provide(layer))
    },
    { timeout: 60_000 }
  )

  it.effect("shows no earliest day before the archive holds one", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2023-07-03T04:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* disclosureArchivePage(headers(cookie))
      assert.deepInclude(page.coverage, { earliestDay: null, notListed: 1 })
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "starts a run for an admin, and refuses a second while it runs",
    () => {
      const { layer, mails, workflow } = archive()
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-26T04:00:00.000Z"))
        const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
        const { id } = yield* runDisclosuresNow(headers(cookie))
        assert.strictEqual(id, "admin-1795665600000")
        assert.deepStrictEqual(createdIds(workflow), [id])

        yield* TestClock.adjust("1 second")
        const refused = yield* Effect.flip(runDisclosuresNow(headers(cookie)))
        assert.deepStrictEqual(
          refused,
          new Conflict({ message: "A run is in progress." })
        )
        assert.deepStrictEqual(createdIds(workflow), [id])
      }).pipe(Effect.provide(layer))
    }
  )
})
