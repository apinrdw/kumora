import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { scheduledKseiRun, startKseiRun } from "@/server/ksei/runs"
import { RunId } from "@/server/archive/run"
import { startRun } from "@/server/shareholding/runs"

import type { FakeWorkflow } from "../archive/fake-workflow.ts"
import { KSEI_ARCHIVE, runStores, storedRun } from "../archive/runs.ts"

// 10:00 WIB on 14 November 2026.
const MORNING = Date.parse("2026-11-14T03:00:00Z")

const archive = runStores

const fire = ({ layer }: ReturnType<typeof archive>, scheduledTime = MORNING) =>
  scheduledKseiRun(scheduledTime).pipe(Effect.provide(layer))

const createdIds = (workflow: FakeWorkflow) => [...workflow.instances.keys()]

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
      assert.deepInclude(storedRun(ksei.db, KSEI_ARCHIVE, "cron-2026-11-14"), {
        outcome: "running",
        md5Mismatches: [],
        listingFailures: [],
      })
    })
  )

  it.effect("skips while the latest KSEI run is running", () =>
    Effect.gen(function* () {
      const ksei = archive()
      yield* fire(ksei, Date.parse("2026-11-13T03:00:00Z"))
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
        startKseiRun(RunId.make("admin-1763089200000"), "admin").pipe(
          Effect.provide(ksei.layer)
        )
      )

      assert.strictEqual(refused._tag, "RunInProgress")
      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
    })
  )

  it.effect("refuses Deep backfill while the latest KSEI run is running", () =>
    Effect.gen(function* () {
      const ksei = archive()
      yield* fire(ksei)

      const refused = yield* Effect.flip(
        startKseiRun(RunId.make("deep-1763089200000"), "deep").pipe(
          Effect.provide(ksei.layer)
        )
      )

      assert.strictEqual(refused._tag, "RunInProgress")
      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
    })
  )

  it.effect("starts while a shareholding archive run is in progress", () =>
    Effect.gen(function* () {
      // Both archives keep their runs in one ArchiveDb.
      const ksei = archive()
      const idx = archive(ksei.db)
      yield* startRun(RunId.make("cron-2026-11-14T03"), "cron").pipe(
        Effect.provide(idx.layer)
      )

      yield* fire(ksei)

      assert.deepStrictEqual(createdIds(idx.workflow), ["cron-2026-11-14T03"])
      assert.deepStrictEqual(createdIds(ksei.workflow), ["cron-2026-11-14"])
    })
  )
})
