import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCodesProtocolVersion,
  WibDate,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { Effect, Option } from "effect"

import type { BrokerCodesTarget } from "../../src/worker/broker-codes/poster.ts"
import { makeProductionTarget } from "../../src/worker/broker-codes/production-target.ts"
import type { StatusRefusal } from "../../src/worker/broker-codes/status.ts"
import { DashboardOrigin } from "../../src/worker/settings.ts"

const DAY = WibDate.make("2026-11-12")
const PRODUCTION: BrokerCodesTarget = {
  origin: DashboardOrigin.make("https://dashboard.example"),
  token: "ingest-token",
}
const BATCH: BrokerCodesBatch = {
  version: BrokerCodesProtocolVersion,
  feed: "Stockbit",
  day: DAY,
  rows: [],
}

// Production answering every POST and status read with `status`, keeping
// each state it was stopped with.
const answering = (status: number) =>
  Effect.gen(function* () {
    const stops: Array<StatusRefusal> = []
    const production = yield* makeProductionTarget({
      target: Effect.succeed(Option.some(PRODUCTION)),
      send: () => Effect.succeed(status),
      get: () => Effect.succeed({ status, body: "" }),
      stop: (state) => Effect.sync(() => void stops.push(state)),
    })
    return { ...production, stops }
  })

describe("Production's broker codes target", () => {
  it.effect("stops Production's Target state on a POST's 401 or 426", () =>
    Effect.gen(function* () {
      const rejected = yield* answering(401)
      assert.strictEqual(yield* rejected.post(BATCH), "rejected-token")
      assert.deepStrictEqual(rejected.stops, ["rejected-token"])
      const reload = yield* answering(426)
      assert.strictEqual(yield* reload.post(BATCH), "reload-extension")
      assert.deepStrictEqual(reload.stops, ["reload-extension"])
    })
  )

  it.effect(
    "stops Production's Target state on a status read's 401 or 426",
    () =>
      Effect.gen(function* () {
        const rejected = yield* answering(401)
        assert.strictEqual(yield* rejected.status(DAY), "rejected-token")
        assert.deepStrictEqual(rejected.stops, ["rejected-token"])
        const reload = yield* answering(426)
        assert.strictEqual(yield* reload.status(DAY), "reload-extension")
        assert.deepStrictEqual(reload.stops, ["reload-extension"])
      })
  )

  it.effect("stops nothing on a batch written", () =>
    Effect.gen(function* () {
      const written = yield* answering(200)
      assert.strictEqual(yield* written.post(BATCH), "sent")
      assert.deepStrictEqual(written.stops, [])
    })
  )
})
