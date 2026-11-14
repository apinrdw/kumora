import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { nextScheduledRun } from "@/server/shareholding/schedule"

const next = (iso: string) =>
  Effect.map(nextScheduledRun(new Date(iso)), (date) => date.toISOString())

describe("the next scheduled archive run", () => {
  it.effect("is 13:00 WIB the same day before 13:00 WIB", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* next("2026-11-14T02:00:00.000Z"),
        "2026-11-14T06:00:00.000Z"
      )
    })
  )

  it.effect("is 20:00 WIB once 13:00 WIB has passed", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* next("2026-11-14T06:00:00.000Z"),
        "2026-11-14T13:00:00.000Z"
      )
    })
  )

  it.effect("is 13:00 WIB the next day once 20:00 WIB has passed", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* next("2026-11-14T16:59:00.000Z"),
        "2026-11-15T06:00:00.000Z"
      )
    })
  )
})
