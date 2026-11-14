import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { scheduledKseiRun, startKseiRun } from "@/server/ksei/runs"
import { ArchiveRunId } from "@/server/archive/run"
import { startRun } from "@/server/shareholding/runs"

import { fakeWorkflow, type FakeWorkflow } from "../archive/fake-workflow.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"

// 10:00 WIB on 14 November 2026.
const MORNING = Date.parse("2026-11-14T03:00:00Z")

const archive = () => {
  const bucket = memoryBucket()
  const workflow = fakeWorkflow()
  return { bucket, workflow, layer: Layer.merge(bucket.layer, workflow.layer) }
}

const fire = ({ layer }: ReturnType<typeof archive>, scheduledTime = MORNING) =>
  scheduledKseiRun(scheduledTime).pipe(Effect.provide(layer))

const createdIds = (workflow: FakeWorkflow) => [...workflow.instances.keys()]

const pointLatestAt = (bucket: MemoryBucket, id: string) =>
  bucket.objects.set("runs/latest.json", {
    body: JSON.stringify({ id }),
    contentType: "application/json",
    customMetadata: {},
  })

describe("the KSEI archive cron", () => {
  it.effect("starts a run named after its scheduled date", () =>
    Effect.gen(function* () {
      const ksei = archive()
      yield* fire(ksei)

      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
      assert.deepStrictEqual(
        ksei.workflow.instances.get("cron-2026-11-14")?.options,
        {
          id: "cron-2026-11-14",
          params: { trigger: "cron" },
          retention: {
            successRetention: "30 days",
            errorRetention: "30 days",
          },
        }
      )
      assert.deepInclude(
        JSON.parse(
          ksei.bucket.objects.get("runs/cron-2026-11-14.json")?.body ?? "null"
        ),
        { outcome: "running", md5Mismatches: [], listingFailures: [] }
      )
    })
  )

  it.effect("skips while the latest KSEI run is running", () =>
    Effect.gen(function* () {
      const ksei = archive()
      yield* fire(ksei, Date.parse("2026-11-13T03:00:00Z"))
      pointLatestAt(ksei.bucket, "cron-2026-11-13")
      const previous = ksei.workflow.instances.get("cron-2026-11-13")
      assert.isDefined(previous)
      previous.status = "running"

      yield* fire(ksei)

      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-13"])
    })
  )

  it.effect("refuses Run now while the latest KSEI run is running", () =>
    Effect.gen(function* () {
      const ksei = archive()
      yield* fire(ksei)

      const refused = yield* Effect.flip(
        startKseiRun(ArchiveRunId.make("admin-1763089200000"), "admin").pipe(
          Effect.provide(ksei.layer)
        )
      )

      assert.strictEqual(refused._tag, "RunInProgress")
      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
    })
  )

  it.effect("starts while a shareholding archive run is in progress", () =>
    Effect.gen(function* () {
      const idx = archive()
      const ksei = archive()
      yield* startRun(ArchiveRunId.make("cron-2026-11-14T03"), "cron").pipe(
        Effect.provide(idx.layer)
      )

      yield* fire(ksei)

      assert.deepStrictEqual(createdIds(idx.workflow), ["cron-2026-11-14T03"])
      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
    })
  )
})
