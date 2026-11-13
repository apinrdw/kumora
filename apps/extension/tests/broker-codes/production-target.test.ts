import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCodesProtocolVersion,
  WibDate,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { Effect, Option } from "effect"

import type { BrokerCodesTarget } from "../../src/worker/broker-codes/poster.ts"
import { makeProductionTarget } from "../../src/worker/broker-codes/production-target.ts"
import { makeTargetHold } from "../../src/worker/broker-codes/target-hold.ts"
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
// each state its hold moved to, and counting the requests.
const answering = Effect.fnUntraced(function* (status: number) {
  let settings = PRODUCTION
  const states: Array<string> = []
  const requests = { sends: 0, reads: 0 }
  const changed: Effect.Effect<void> = Effect.suspend(() =>
    Effect.map(hold.state, (state) => {
      states.push(Option.getOrElse(state, () => "cleared"))
    })
  )
  const hold = yield* makeTargetHold(changed)
  yield* hold.restart(Option.some(settings))
  const production = yield* makeProductionTarget({
    target: Effect.sync(() => Option.some(settings)),
    send: () =>
      Effect.sync(() => {
        requests.sends++
        return status
      }),
    get: () =>
      Effect.sync(() => {
        requests.reads++
        return { status, body: "" }
      }),
    hold,
  })
  return {
    ...production,
    states,
    requests,
    hold,
    // The settings change as makeTargets in service-worker.ts applies them.
    switchTo: (next: BrokerCodesTarget) =>
      Effect.suspend(() => {
        settings = next
        return hold.restart(Option.some(next))
      }),
  }
})

const NEW_TOKEN: BrokerCodesTarget = { ...PRODUCTION, token: "new-token" }

describe("Production's broker codes target", () => {
  it.effect("stops Production's Target state on a POST's 401 or 426", () =>
    Effect.gen(function* () {
      const rejected = yield* answering(401)
      assert.strictEqual(yield* rejected.post(BATCH), "rejected-token")
      assert.deepStrictEqual(rejected.states, ["rejected-token"])
      const reload = yield* answering(426)
      assert.strictEqual(yield* reload.post(BATCH), "reload-extension")
      assert.deepStrictEqual(reload.states, ["reload-extension"])
    })
  )

  it.effect(
    "stops Production's Target state on a status read's 401 or 426",
    () =>
      Effect.gen(function* () {
        const rejected = yield* answering(401)
        assert.strictEqual(yield* rejected.status(DAY), "rejected-token")
        assert.deepStrictEqual(rejected.states, ["rejected-token"])
        const reload = yield* answering(426)
        assert.strictEqual(yield* reload.status(DAY), "reload-extension")
        assert.deepStrictEqual(reload.states, ["reload-extension"])
      })
  )

  it.effect("a refusal stops Production until its settings change", () =>
    Effect.gen(function* () {
      const production = yield* answering(401)
      assert.strictEqual(yield* production.post(BATCH), "rejected-token")
      assert.strictEqual(yield* production.post(BATCH), "rejected-token")
      assert.strictEqual(yield* production.status(DAY), "rejected-token")
      assert.deepStrictEqual(production.requests, { sends: 1, reads: 0 })
      yield* production.switchTo(NEW_TOKEN)
      assert.isTrue(Option.isNone(yield* production.hold.state))
      assert.strictEqual(yield* production.status(DAY), "rejected-token")
      assert.deepStrictEqual(production.requests, { sends: 1, reads: 1 })
    })
  )

  it.effect("a refusal on settings since changed stops nothing", () =>
    Effect.gen(function* () {
      const hold = yield* makeTargetHold(Effect.void)
      let settings = PRODUCTION
      yield* hold.restart(Option.some(settings))
      let sends = 0
      const production = yield* makeProductionTarget({
        target: Effect.sync(() => Option.some(settings)),
        // The token changes while the first POST is in flight.
        send: () =>
          Effect.suspend(() => {
            sends++
            if (sends > 1) return Effect.succeed(200)
            settings = NEW_TOKEN
            return Effect.as(hold.restart(Option.some(NEW_TOKEN)), 401)
          }),
        get: () => Effect.succeed({ status: 200, body: "" }),
        hold,
      })
      assert.strictEqual(yield* production.post(BATCH), "rejected-token")
      assert.isTrue(Option.isNone(yield* hold.state))
      assert.strictEqual(yield* production.post(BATCH), "sent")
    })
  )

  it.effect("stops nothing on a batch written", () =>
    Effect.gen(function* () {
      const written = yield* answering(200)
      assert.strictEqual(yield* written.post(BATCH), "sent")
      assert.deepStrictEqual(written.states, [])
    })
  )
})
