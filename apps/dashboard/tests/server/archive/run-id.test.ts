import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { DuplicateRunId, WorkflowError } from "@/server/archive/workflow"
import { runKey } from "@/server/archive/run"

describe("an archive run's id", () => {
  it.effect("is an ArchiveRunId wherever a run is named", () =>
    Effect.gen(function* () {
      // @ts-expect-error a bare string is not an archive run's id
      const key = yield* runKey("cron-2026-11-14T06")
      assert.strictEqual(key, "runs/cron-2026-11-14T06.json")
      // @ts-expect-error a bare string is not an archive run's id
      assert.isDefined(new DuplicateRunId({ id: "cron-2026-11-14T06" }))
      assert.isDefined(
        new WorkflowError({
          operation: "create",
          // @ts-expect-error a bare string is not an archive run's id
          id: "cron-2026-11-14T06",
          cause: new Error("Workflows is unavailable"),
        })
      )
    })
  )
})
