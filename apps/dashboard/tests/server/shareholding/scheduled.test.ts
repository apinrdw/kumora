import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"

import {
  runInProgress,
  scheduledArchiveRun,
  startRun,
} from "@/server/shareholding/start-run"

import { fakeWorkflow, type FakeWorkflow } from "./fake-workflow.ts"
import { type MemoryBucket, memoryBucket } from "./memory-bucket.ts"

// 13:00 WIB on 14 November 2026.
const AFTERNOON = Date.parse("2026-11-14T06:00:00Z")

const fire = (
  workflow: FakeWorkflow,
  bucket: MemoryBucket,
  scheduledTime = AFTERNOON
) =>
  scheduledArchiveRun(scheduledTime).pipe(
    Effect.provide(Layer.merge(workflow.layer, bucket.layer))
  )

const pointLatestAt = (bucket: MemoryBucket, id: string) =>
  bucket.objects.set("runs/latest.json", {
    body: JSON.stringify({ id }),
    contentType: "application/json",
    customMetadata: {},
  })

describe("the archive cron", () => {
  it.effect("starts a run named after its scheduled hour", () =>
    Effect.gen(function* () {
      const workflow = fakeWorkflow()
      yield* fire(workflow, memoryBucket())

      assert.deepStrictEqual(
        [...workflow.instances.keys()],
        ["cron-2026-11-14T06"]
      )
      assert.deepStrictEqual(
        workflow.instances.get("cron-2026-11-14T06")?.options,
        {
          id: "cron-2026-11-14T06",
          params: { trigger: "cron" },
          retention: {
            successRetention: "30 days",
            errorRetention: "30 days",
          },
        }
      )
    })
  )

  for (const status of ["queued", "running", "waiting"] as const)
    it.effect(`skips while the latest run is ${status}`, () =>
      Effect.gen(function* () {
        const workflow = fakeWorkflow()
        const bucket = memoryBucket()
        yield* fire(workflow, bucket, Date.parse("2026-11-13T13:00:00Z"))
        pointLatestAt(bucket, "cron-2026-11-13T13")
        const previous = workflow.instances.get("cron-2026-11-13T13")
        assert.isDefined(previous)
        previous.status = status

        yield* fire(workflow, bucket)

        assert.deepStrictEqual(
          [...workflow.instances.keys()],
          ["cron-2026-11-13T13"]
        )
      })
    )

  for (const status of ["complete", "errored", "terminated"] as const)
    it.effect(`starts once the latest run is ${status}`, () =>
      Effect.gen(function* () {
        const workflow = fakeWorkflow()
        const bucket = memoryBucket()
        yield* fire(workflow, bucket, Date.parse("2026-11-13T13:00:00Z"))
        pointLatestAt(bucket, "cron-2026-11-13T13")
        const previous = workflow.instances.get("cron-2026-11-13T13")
        assert.isDefined(previous)
        previous.status = status

        yield* fire(workflow, bucket)

        assert.deepStrictEqual(
          [...workflow.instances.keys()],
          ["cron-2026-11-13T13", "cron-2026-11-14T06"]
        )
      })
    )

  it.effect("ignores a second firing for the same hour", () =>
    Effect.gen(function* () {
      const workflow = fakeWorkflow()
      const bucket = memoryBucket()
      yield* fire(workflow, bucket)
      pointLatestAt(bucket, "cron-2026-11-14T06")
      const first = workflow.instances.get("cron-2026-11-14T06")
      assert.isDefined(first)
      first.status = "complete"

      yield* fire(workflow, bucket)

      assert.deepStrictEqual(
        [...workflow.instances.keys()],
        ["cron-2026-11-14T06"]
      )
      assert.strictEqual(first.status, "complete")
    })
  )

  it.effect("starts when the latest run is past its retention", () =>
    Effect.gen(function* () {
      const workflow = fakeWorkflow()
      const bucket = memoryBucket()
      pointLatestAt(bucket, "cron-2026-10-01T06")

      yield* fire(workflow, bucket)

      assert.deepStrictEqual(
        [...workflow.instances.keys()],
        ["cron-2026-11-14T06"]
      )
    })
  )
})

// What Run now (apinrdw/kumora#309) builds on.
describe("starting a run by hand", () => {
  it.effect("names the run in progress, and nothing once it ends", () =>
    Effect.gen(function* () {
      const workflow = fakeWorkflow()
      const bucket = memoryBucket()
      const layer = Layer.merge(workflow.layer, bucket.layer)
      const check = runInProgress.pipe(Effect.provide(layer))
      assert.isTrue(Option.isNone(yield* check))

      yield* startRun("admin-1763125200000", "admin").pipe(
        Effect.provide(layer)
      )
      assert.deepStrictEqual(yield* check, Option.some("admin-1763125200000"))

      const run = workflow.instances.get("admin-1763125200000")
      assert.isDefined(run)
      assert.deepStrictEqual(run.options, {
        id: "admin-1763125200000",
        params: { trigger: "admin" },
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      })
      run.status = "complete"
      assert.isTrue(Option.isNone(yield* check))
    })
  )

  it.effect(
    "refuses a cron firing right after a start, before the run's plan step",
    () =>
      Effect.gen(function* () {
        const workflow = fakeWorkflow()
        const bucket = memoryBucket()
        yield* startRun("admin-1763125200000", "admin").pipe(
          Effect.provide(Layer.merge(workflow.layer, bucket.layer))
        )

        yield* fire(workflow, bucket)

        assert.deepStrictEqual(
          [...workflow.instances.keys()],
          ["admin-1763125200000"]
        )
        assert.strictEqual(
          JSON.parse(
            bucket.objects.get("runs/admin-1763125200000.json")?.body ?? "null"
          ).outcome,
          "running"
        )
      })
  )
})
