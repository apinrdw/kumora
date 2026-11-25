import { assert, describe, it } from "@effect/vitest"
import { StageUrl } from "@workspace/deploy/stage-url"
import {
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  encodeBrokerCodesStatus,
  type BrokerCodesStatus,
} from "@workspace/relay"
import { Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import type { BrokerCodesTarget } from "../../src/worker/broker-codes/poster.ts"
import {
  makeBrokerCodesStatus,
  type Get,
} from "../../src/worker/broker-codes/status.ts"

const DAY = WibDate.make("2026-11-12")
const PRODUCTION: BrokerCodesTarget = {
  url: StageUrl.make("https://dashboard.example"),
  token: "ingest-token",
}
const STATUS: BrokerCodesStatus = {
  version: BrokerCodesProtocolVersion,
  day: DAY,
  n: null,
  complete: false,
  missing: [[TradeNumber.make("1"), TradeNumber.make("40")]],
  missingCount: 40,
  sources: { ajaib: 0, stockbit: 60 },
  orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
  crossCheck: { state: "none" },
}

// A target answering each GET with the next of `answers` (then the status),
// keeping each request.
const fakeTarget = Effect.fnUntraced(function* (
  answers: ReadonlyArray<{ status: number; body: string }>
) {
  const body = yield* encodeBrokerCodesStatus(STATUS)
  const requests: Array<Parameters<Get>[0]> = []
  return {
    requests,
    get: (request: Parameters<Get>[0]) =>
      Effect.sync(() => {
        requests.push(request)
        return answers[requests.length - 1] ?? { status: 200, body }
      }),
  }
})

describe("reading a day's broker codes status", () => {
  it.effect("asks the day's path with the ingest token, and decodes it", () =>
    Effect.gen(function* () {
      const target = yield* fakeTarget([])
      const reader = yield* makeBrokerCodesStatus({
        target: Effect.succeed(Option.some(PRODUCTION)),
        get: target.get,
      })
      assert.deepStrictEqual(yield* reader.status(DAY), STATUS)
      assert.deepStrictEqual(
        yield* reader.status(DAY, TradeNumber.make("2000")),
        STATUS
      )
      assert.deepStrictEqual(target.requests, [
        {
          target: PRODUCTION,
          url: "https://dashboard.example/api/broker-codes/2026-11-12?after=0",
        },
        {
          target: PRODUCTION,
          url: "https://dashboard.example/api/broker-codes/2026-11-12?after=2000",
        },
      ])
    })
  )

  it.effect("asks under a dashboard served at a path", () =>
    Effect.gen(function* () {
      const target = yield* fakeTarget([])
      const reader = yield* makeBrokerCodesStatus({
        target: Effect.succeed(
          Option.some({
            ...PRODUCTION,
            url: StageUrl.make("https://dashboard.example/dashboard"),
          })
        ),
        get: target.get,
      })
      assert.deepStrictEqual(yield* reader.status(DAY), STATUS)
      assert.deepStrictEqual(
        target.requests.map(({ url }) => url),
        [
          "https://dashboard.example/dashboard/api/broker-codes/2026-11-12?after=0",
        ]
      )
    })
  )

  it.effect("asks again with backoff after a failure", () =>
    Effect.gen(function* () {
      const target = yield* fakeTarget([
        { status: 0, body: "" },
        { status: 503, body: "" },
      ])
      const reader = yield* makeBrokerCodesStatus({
        target: Effect.succeed(Option.some(PRODUCTION)),
        get: target.get,
      })
      const fiber = yield* Effect.forkChild(reader.status(DAY))
      yield* TestClock.adjust("1 second")
      assert.lengthOf(target.requests, 2)
      yield* TestClock.adjust("2 seconds")
      assert.deepStrictEqual(yield* Fiber.join(fiber), STATUS)
    })
  )

  it.effect(
    "answers why there is no status: no token, a 401, a 426, another version",
    () =>
      Effect.gen(function* () {
        const off = yield* makeBrokerCodesStatus({
          target: Effect.succeedNone,
          get: (yield* fakeTarget([])).get,
        })
        assert.strictEqual(yield* off.status(DAY), "off")
        const answering = (status: number, body = "") =>
          Effect.flatMap(fakeTarget([{ status, body }]), (target) =>
            Effect.flatMap(
              makeBrokerCodesStatus({
                target: Effect.succeed(Option.some(PRODUCTION)),
                get: target.get,
              }),
              (reader) => reader.status(DAY)
            )
          )
        assert.strictEqual(yield* answering(401), "rejected-token")
        assert.strictEqual(yield* answering(426), "reload-extension")
        assert.strictEqual(
          yield* answering(200, JSON.stringify({ ...STATUS, version: 1 })),
          "reload-extension"
        )
      })
  )
})
