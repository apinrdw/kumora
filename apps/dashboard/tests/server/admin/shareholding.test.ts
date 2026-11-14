import { assert, describe, it } from "@effect/vitest"
import { Conflict, Unauthorized } from "@workspace/server"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import {
  runArchiveNow,
  shareholdingArchivePage,
} from "@/server/admin/shareholding"
import type { Mail } from "@/server/auth/mailer"
import {
  ArchiveRunId,
  type ArchiveRunResult,
} from "@/server/shareholding/run-result"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"
import {
  fakeWorkflow,
  type FakeWorkflow,
} from "../shareholding/fake-workflow.ts"
import {
  type MemoryBucket,
  memoryBucket,
} from "../shareholding/memory-bucket.ts"

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

const RUNNING: ArchiveRunResult = {
  id: ArchiveRunId.make("cron-2026-11-14T13"),
  trigger: "cron",
  startedAt: "2026-11-14T13:00:00.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  notStored: [],
  other: [],
  error: null,
}

const seedLatest = (bucket: MemoryBucket, run: ArchiveRunResult) => {
  for (const [key, value] of [
    [`runs/${run.id}.json`, run],
    ["runs/latest.json", { id: run.id }],
  ] as const)
    bucket.objects.set(key, {
      body: JSON.stringify(value),
      contentType: "application/json",
      customMetadata: {},
    })
}

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

const runningInstance = (workflow: FakeWorkflow, id: string) =>
  workflow.instances.set(id, {
    options: {
      id: ArchiveRunId.make(id),
      params: { trigger: "cron" },
      retention: { successRetention: "30 days", errorRetention: "30 days" },
    },
    status: "running",
  })

describe("the shareholding archive page", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = archive()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(shareholdingArchivePage(headers()))
      assert.deepStrictEqual(
        error,
        new Unauthorized({
          redirectTo: "/sign-in?redirect=%2Fadmin%2Fshareholding",
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member, and starts no run for one", () => {
    const { layer, mails, workflow } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const page = yield* Effect.flip(shareholdingArchivePage(headers(cookie)))
      assert.strictEqual(page._tag, "NotFound")
      const run = yield* Effect.flip(runArchiveNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      assert.deepStrictEqual(createdIds(workflow), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin no run yet, and the next scheduled run", () => {
    const { layer, mails } = archive()
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T07:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.isUndefined(page.lastRun)
      assert.strictEqual(page.nextRun, "2026-11-14T13:00:00.000Z")
      assert.deepStrictEqual(page.recentRuns, [])
      assert.strictEqual(page.totals.reports, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin the recent runs and the archive totals", () => {
    const { layer, mails, bucket } = archive()
    const finished: ArchiveRunResult = {
      ...RUNNING,
      finishedAt: "2026-11-14T13:01:12.000Z",
      outcome: "complete",
      reportsAdded: 1,
    }
    seedLatest(bucket, finished)
    bucket.objects.set("reports/above-1/2026-10-31/aa.xlsx", {
      body: "xlsx",
      contentType: "application/octet-stream",
      customMetadata: {},
    })
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T14:00:00.000Z"))
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.deepStrictEqual(page.recentRuns, [finished])
      assert.deepStrictEqual(
        page.totals.kinds.find(({ kind }) => kind === "above-1"),
        { kind: "above-1", reports: 1 }
      )
      assert.strictEqual(page.totals.bytes, 4)
    }).pipe(Effect.provide(layer))
  })
})

describe("Run now", () => {
  it.effect("starts an admin run named by the time", () => {
    const { layer, mails, workflow, bucket } = archive()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* TestClock.setTime(1_763_125_032_000)
      assert.deepStrictEqual(yield* runArchiveNow(headers(cookie)), {
        id: "admin-1763125032000",
      })
      assert.deepStrictEqual(createdIds(workflow), ["admin-1763125032000"])
      assert.deepStrictEqual(
        workflow.instances.get("admin-1763125032000")?.options.params,
        { trigger: "admin" }
      )
      // The run is in progress from the moment it is created, before its
      // plan step writes the record: a second Run now is refused at once.
      const page = yield* shareholdingArchivePage(headers(cookie))
      assert.strictEqual(page.lastRun?.result.id, "admin-1763125032000")
      assert.isTrue(page.lastRun?.inProgress)
      const again = yield* Effect.flip(runArchiveNow(headers(cookie)))
      assert.strictEqual(again._tag, "Conflict")
      assert.deepStrictEqual(createdIds(workflow), ["admin-1763125032000"])
      assert.strictEqual(
        bucket.objects.get("runs/latest.json")?.body,
        JSON.stringify({ id: "admin-1763125032000" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("is refused while the latest run is running", () => {
    const { layer, mails, workflow, bucket } = archive()
    seedLatest(bucket, RUNNING)
    runningInstance(workflow, RUNNING.id)
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const error = yield* Effect.flip(runArchiveNow(headers(cookie)))
      assert.deepStrictEqual(
        error,
        new Conflict({ message: "A run is in progress." })
      )
      assert.deepStrictEqual(createdIds(workflow), [RUNNING.id])
    }).pipe(Effect.provide(layer))
  })

  it.effect("starts a run once the running one's Workflow errored", () => {
    const { layer, mails, workflow, bucket } = archive()
    seedLatest(bucket, RUNNING)
    runningInstance(workflow, RUNNING.id)
    const previous = workflow.instances.get(RUNNING.id)
    if (previous !== undefined) previous.status = "errored"
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* runArchiveNow(headers(cookie))
      assert.strictEqual(createdIds(workflow).length, 2)
    }).pipe(Effect.provide(layer))
  })
})
