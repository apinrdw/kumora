import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  decodeBrokerCodesBatch,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
} from "../../src/worker/broker-codes/poster.ts"
import { DashboardOrigin } from "../../src/worker/settings.ts"

const PRODUCTION: BrokerCodesTarget = {
  origin: DashboardOrigin.make("https://dashboard.example"),
  token: "ingest-token",
}

const BATCH: BrokerCodesBatch = {
  version: BrokerCodesProtocolVersion,
  feed: "Ajaib",
  day: WibDate.make("2026-11-12"),
  rows: [
    [
      TradeNumber.make("17"),
      {
        buyer: BrokerCode.make("YP"),
        buyerType: "D",
        seller: BrokerCode.make("PD"),
        sellerType: "F",
      },
    ],
  ],
}

// A target answering each POST with the next status in `statuses` (then 200),
// keeping each request and the test-clock time it came.
const fakeTarget = (statuses: ReadonlyArray<number>) => {
  const requests: Array<{ url: string; token: string; body: string }> = []
  return {
    requests,
    send: (request: { url: string; token: string; body: string }) =>
      Effect.sync(() => {
        requests.push(request)
        return statuses[requests.length - 1] ?? 200
      }),
  }
}

describe("posting broker codes to a target", () => {
  it.effect("posts the batch to the day's path with the ingest token", () =>
    Effect.gen(function* () {
      const target = fakeTarget([])
      const poster = yield* makeBrokerCodesPoster({
        target: Effect.succeed(Option.some(PRODUCTION)),
        send: target.send,
      })
      assert.strictEqual(yield* poster.post(BATCH), "sent")
      assert.lengthOf(target.requests, 1)
      const [request] = target.requests
      assert.strictEqual(
        request?.url,
        "https://dashboard.example/api/broker-codes/2026-11-12"
      )
      assert.strictEqual(request?.token, "ingest-token")
      assert.deepStrictEqual(
        yield* decodeBrokerCodesBatch(request?.body ?? ""),
        BATCH
      )
    })
  )

  it.effect("resends a failed POST, 1 s then 2 s later", () =>
    Effect.gen(function* () {
      const target = fakeTarget([500, 0])
      const poster = yield* makeBrokerCodesPoster({
        target: Effect.succeed(Option.some(PRODUCTION)),
        send: target.send,
      })
      const fiber = yield* Effect.forkChild(poster.post(BATCH))
      yield* TestClock.adjust("0 millis")
      assert.lengthOf(target.requests, 1)
      yield* TestClock.adjust("1 second")
      assert.lengthOf(target.requests, 2)
      yield* TestClock.adjust("1 second")
      assert.lengthOf(target.requests, 2)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Fiber.join(fiber), "sent")
      assert.lengthOf(target.requests, 3)
      assert.strictEqual(target.requests[2]?.body, target.requests[0]?.body)
    })
  )

  it.effect("stops on a rejected token or a version mismatch", () =>
    Effect.gen(function* () {
      for (const [status, outcome] of [
        [401, "rejected-token"],
        [426, "reload-extension"],
      ] as const) {
        const target = fakeTarget([status])
        const poster = yield* makeBrokerCodesPoster({
          target: Effect.succeed(Option.some(PRODUCTION)),
          send: target.send,
        })
        assert.strictEqual(yield* poster.post(BATCH), outcome)
        assert.lengthOf(target.requests, 1)
      }
    })
  )

  it.effect("sends nothing while the target has no token", () =>
    Effect.gen(function* () {
      const target = fakeTarget([])
      const poster = yield* makeBrokerCodesPoster({
        target: Effect.succeed(Option.none()),
        send: target.send,
      })
      assert.strictEqual(yield* poster.post(BATCH), "off")
      assert.deepStrictEqual(target.requests, [])
    })
  )
})
