import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { RunId } from "@/server/archive/run"
import { startDisclosureRun } from "@/server/disclosures/runs"
import { startKseiRun } from "@/server/ksei/runs"

import { runStores, storedRun } from "../archive/runs.ts"

const DISCLOSURE_RUN = { archive: "disclosure", runKind: "archive" } as const

const start = (stores: ReturnType<typeof runStores>, at: number) =>
  startDisclosureRun(RunId.make(`admin-${at}`), "admin").pipe(
    Effect.provide(stores.layer)
  )

describe("starting a disclosure run", () => {
  it.effect("records it running and creates its Workflow instance", () =>
    Effect.gen(function* () {
      const stores = runStores()
      yield* start(stores, 1)
      assert.deepStrictEqual([...stores.workflow.instances.keys()], ["admin-1"])
      assert.deepInclude(storedRun(stores.db, DISCLOSURE_RUN, "admin-1"), {
        outcome: "running",
        trigger: "admin",
      })
    })
  )

  it.effect("refuses one of two starts at once", () =>
    Effect.gen(function* () {
      const stores = runStores()
      const [first, second] = yield* Effect.all(
        [Effect.result(start(stores, 1)), Effect.result(start(stores, 2))],
        { concurrency: "unbounded" }
      )
      const refused = [first, second].filter(
        (result) => result._tag === "Failure"
      )
      assert.strictEqual(refused.length, 1)
      assert.strictEqual(
        refused[0]?._tag === "Failure" ? refused[0].failure._tag : undefined,
        "RunInProgress"
      )
      assert.strictEqual(stores.workflow.instances.size, 1)
    })
  )

  it.effect("starts again once the last run has ended", () =>
    Effect.gen(function* () {
      const stores = runStores()
      yield* start(stores, 1)
      const first = stores.workflow.instances.get("admin-1")
      assert.isDefined(first)
      first.status = "complete"
      yield* start(stores, 2)
      assert.strictEqual(stores.workflow.instances.size, 2)
    })
  )

  it.effect("starts while a KSEI archive run is in progress", () =>
    Effect.gen(function* () {
      const disclosures = runStores()
      const ksei = runStores(disclosures.db)
      yield* startKseiRun(RunId.make("admin-1"), "admin").pipe(
        Effect.provide(ksei.layer)
      )
      yield* start(disclosures, 2)
      assert.strictEqual(disclosures.workflow.instances.size, 1)
    })
  )
})
