// The page's stock code list against a Worker that has no list yet, or
// couldn't answer: the live page asks again until the relay delivers it, a
// recorded day takes a 404 as final, and either asks again after a failure.
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect, Fiber, Queue } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { TestClock } from "effect/testing"

import {
  RETRY_INTERVAL,
  followStockCodeList,
  type StockCodeList,
} from "@/components/market-live/use-stock-code-list"

const DAY = WibDate.make("2026-11-09")
const LIST = JSON.stringify({
  codes: [{ code: "BBCA", name: "Bank Central Asia Tbk", kind: "share" }],
})

// A Worker answering the code list GET with `statuses` in turn, then 200
// with the list; the relative path needs an origin outside a browser.
const worker = (statuses: ReadonlyArray<number>) => {
  const pending = [...statuses]
  let asked = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      asked += 1
      const status = pending.shift() ?? 200
      return HttpClientResponse.fromWeb(
        request,
        new Response(status === 200 ? LIST : "No stock code list", { status })
      )
    })
  ).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://dashboard.test"))
  )
  return { client, asked: () => asked }
}

// Follows the list of `shown` against that Worker: each list handed to the
// page is queued, and "Ended" once the following stops.
const follow = (shown: WibDate | undefined, statuses: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const { client, asked } = worker(statuses)
    const lists = yield* Queue.make<StockCodeList["_tag"] | "Ended">()
    const fiber = yield* followStockCodeList(shown, DAY, (list) =>
      Queue.offerUnsafe(lists, list._tag)
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.forkChild
    )
    yield* Effect.forkChild(
      Effect.andThen(Fiber.await(fiber), Queue.offer(lists, "Ended"))
    )
    return { next: Queue.take(lists), asked }
  })

describe("the page's stock code list", () => {
  it.effect(
    "asks for the live day's list again until the relay delivers it",
    () =>
      Effect.gen(function* () {
        const { next, asked } = yield* follow(undefined, [404, 500, 404])
        assert.strictEqual(yield* next, "Missing")
        yield* TestClock.adjust(RETRY_INTERVAL)
        // The failed ask hands the page nothing; the ask after it does.
        yield* TestClock.adjust(RETRY_INTERVAL)
        assert.strictEqual(yield* next, "Missing")
        yield* TestClock.adjust(RETRY_INTERVAL)
        assert.strictEqual(yield* next, "Ready")
        assert.strictEqual(yield* next, "Ended")
        yield* TestClock.adjust(RETRY_INTERVAL)
        assert.strictEqual(asked(), 4)
      })
  )

  it.effect("asks for a recorded day's list again after a failed ask", () =>
    Effect.gen(function* () {
      const { next, asked } = yield* follow(DAY, [500])
      yield* TestClock.adjust(RETRY_INTERVAL)
      assert.strictEqual(yield* next, "Ready")
      assert.strictEqual(yield* next, "Ended")
      assert.strictEqual(asked(), 2)
    })
  )

  it.effect("takes a recorded day's missing list as final", () =>
    Effect.gen(function* () {
      const { next, asked } = yield* follow(DAY, [404])
      assert.strictEqual(yield* next, "Missing")
      assert.strictEqual(yield* next, "Ended")
      yield* TestClock.adjust(RETRY_INTERVAL)
      assert.strictEqual(asked(), 1)
    })
  )
})
