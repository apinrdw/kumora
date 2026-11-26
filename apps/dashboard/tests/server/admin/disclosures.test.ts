import { assert, describe, it } from "@effect/vitest"
import { Conflict, Unauthorized } from "@workspace/server"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import {
  disclosureArchivePage,
  runDisclosuresNow,
} from "@/server/admin/disclosures"
import type { Mail } from "@/server/auth/mailer"
import { RunId } from "@/server/archive/run"
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
import { memoryArchiveDb } from "../archive/memory-archive-db.ts"
import { memoryBucket } from "../archive/memory-bucket.ts"
import { seedRun } from "../archive/runs.ts"

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
      const page = yield* disclosureArchivePage(headers(cookie))
      assert.isUndefined(page.lastRun)
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
