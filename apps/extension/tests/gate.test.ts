import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import { windowAt } from "../src/worker/gate.ts"

// 2026-11-10 is a Tuesday and a trading day; 2026-12-25 is a holiday.
const at = (wib: string) => windowAt(DateTime.makeUnsafe(`${wib}+07:00`))

describe("the relay's streaming window", () => {
  it.effect("opens at 08:40 and closes at 16:35 WIB on a trading day", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* at("2026-11-10T08:39:59"), "closed")
      assert.strictEqual(yield* at("2026-11-10T08:40:00"), "open")
      assert.strictEqual(yield* at("2026-11-10T10:00:00"), "open")
      assert.strictEqual(yield* at("2026-11-10T16:34:59"), "open")
      assert.strictEqual(yield* at("2026-11-10T16:35:00"), "closed")
    })
  )

  it.effect("is an auction during pre-opening and pre-closing", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* at("2026-11-10T08:45:00"), "auction")
      assert.strictEqual(yield* at("2026-11-10T08:59:59"), "auction")
      assert.strictEqual(yield* at("2026-11-10T09:00:00"), "open")
      assert.strictEqual(yield* at("2026-11-10T15:50:00"), "auction")
      assert.strictEqual(yield* at("2026-11-10T16:02:00"), "open")
    })
  )

  it.effect("stays closed on weekends, holidays and unscheduled years", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* at("2026-11-14T10:00:00"), "closed")
      assert.strictEqual(yield* at("2026-12-25T10:00:00"), "closed")
      assert.strictEqual(yield* at("2031-11-11T10:00:00"), "closed")
    })
  )
})
