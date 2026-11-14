import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"
import { lastRun } from "@/server/shareholding/runs"

import {
  type FakeInstance,
  fakeWorkflow,
  type FakeWorkflow,
} from "./fake-workflow.ts"
import { type MemoryBucket, memoryBucket } from "./memory-bucket.ts"

const RUNNING: ArchiveRunResult = {
  id: RunId.make("admin-1763125032000"),
  trigger: "admin",
  startedAt: "2026-11-14T13:17:12.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  notStored: [],
  other: [],
  error: null,
}

const COMPLETE: ArchiveRunResult = {
  ...RUNNING,
  id: RunId.make("cron-2026-11-14T13"),
  trigger: "cron",
  startedAt: "2026-11-14T13:00:00.000Z",
  finishedAt: "2026-11-14T13:01:12.000Z",
  outcome: "complete",
  reportsAdded: 2,
  reportsChecked: 147,
}

const seed = (bucket: MemoryBucket, run: ArchiveRunResult) => {
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

const instance = (workflow: FakeWorkflow, id: string) => {
  const created: FakeInstance = {
    options: {
      id: RunId.make(id),
      params: { trigger: "admin" },
      retention: { successRetention: "30 days", errorRetention: "30 days" },
    },
    status: "queued",
  }
  workflow.instances.set(id, created)
  return created
}

const provide = (bucket: MemoryBucket, workflow: FakeWorkflow) =>
  Effect.provide(Layer.merge(bucket.layer, workflow.layer))

// Shortly after RUNNING started.
const AFTER_START = Date.parse("2026-11-14T13:18:00.000Z")

describe("the last archive run", () => {
  it.effect("is none before any run", () => {
    const bucket = memoryBucket()
    return Effect.gen(function* () {
      assert.isUndefined(yield* lastRun)
    }).pipe(provide(bucket, fakeWorkflow()))
  })

  it.effect("is the run runs/latest.json points at", () => {
    const bucket = memoryBucket()
    seed(bucket, COMPLETE)
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* lastRun, {
        result: COMPLETE,
        inProgress: false,
        workflowStatus: null,
      })
    }).pipe(provide(bucket, fakeWorkflow()))
  })

  it.effect("carries a running run's live Workflow status", () => {
    const bucket = memoryBucket()
    const workflow = fakeWorkflow()
    seed(bucket, RUNNING)
    instance(workflow, RUNNING.id).status = "waiting"
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* lastRun, {
        result: RUNNING,
        inProgress: true,
        workflowStatus: "waiting",
      })
    }).pipe(provide(bucket, workflow))
  })

  it.effect(
    "shows a run whose Workflow errored as failed, with its error",
    () => {
      const bucket = memoryBucket()
      const workflow = fakeWorkflow()
      seed(bucket, RUNNING)
      const errored = instance(workflow, RUNNING.id)
      errored.status = "errored"
      errored.error = "www.idx.id answered 403"
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* lastRun, {
          result: {
            ...RUNNING,
            outcome: "failed",
            error: "www.idx.id answered 403",
          },
          inProgress: false,
          workflowStatus: "errored",
        })
      }).pipe(provide(bucket, workflow))
    }
  )

  it.effect(
    "trusts the record of a running run the Workflow doesn't hold, within its retention",
    () => {
      const bucket = memoryBucket()
      seed(bucket, RUNNING)
      return Effect.gen(function* () {
        yield* TestClock.setTime(AFTER_START)
        assert.deepStrictEqual(yield* lastRun, {
          result: RUNNING,
          inProgress: true,
          workflowStatus: null,
        })
      }).pipe(provide(bucket, fakeWorkflow()))
    }
  )

  it.effect(
    "shows a run still running past its retention as failed, so it never blocks a new one",
    () => {
      const bucket = memoryBucket()
      seed(bucket, RUNNING)
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-12-15T00:00:00.000Z"))
        const run = yield* lastRun
        assert.strictEqual(run?.result.outcome, "failed")
        assert.isFalse(run?.inProgress)
      }).pipe(provide(bucket, fakeWorkflow()))
    }
  )
})
