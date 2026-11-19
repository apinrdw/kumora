// A recorded day's GETs against a Worker answering each status: only a 404
// means nothing was recorded; a failing Worker fails, so the page's caches
// never hold a failure as a missing chunk.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, TradeNumber, WibDate } from "@workspace/relay"
import { DateTime, Duration, Effect, Layer, Option } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { TestClock } from "effect/testing"

import {
  fetchRecordedBookChunk,
  fetchRecordedBrokerCodes,
  followSweepBrokers,
  makeBrokerCodesFollower,
  type RecordedTradeCodes,
} from "@workspace/client"

const DAY = WibDate.make("2026-11-09")
const BBCA = StockCode.make("BBCA")
const MINUTE = DateTime.makeUnsafe("2026-11-09T02:00:00Z")

// A Worker answering every GET with `status`; the relative path needs an
// origin outside a browser.
const worker = (status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("Recorded day not served", { status })
      )
    )
  ).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://dashboard.test"))
  )

const bookChunkFrom = (status: number) =>
  fetchRecordedBookChunk(DAY, BBCA, MINUTE).pipe(
    Effect.provideService(HttpClient.HttpClient, worker(status))
  )

// The browser's fetch, answering the broker codes GET with `body` and
// recording each URL and the cache mode it was asked with.
const browser = (status: number, body: string) => {
  const asked: Array<{ readonly url: string; readonly cache?: string }> = []
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    Effect.runPromise(
      Effect.sync(() => {
        asked.push({
          url: String(input),
          ...(init?.cache === undefined ? {} : { cache: init.cache }),
        })
        return new Response(body, { status })
      })
    )
  return { asked, fetch: fetch as typeof globalThis.fetch }
}

const brokerCodesFrom = (fake: ReturnType<typeof browser>, fresh?: boolean) =>
  fetchRecordedBrokerCodes(DAY, MINUTE, fresh).pipe(
    Effect.provide(
      Layer.effect(HttpClient.HttpClient)(
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            HttpClientRequest.prependUrl("http://dashboard.test")
          )
        )
      ).pipe(Layer.provide(FetchHttpClient.layer))
    ),
    Effect.provideService(FetchHttpClient.Fetch, fake.fetch)
  )

describe("a recorded day's broker codes GET", () => {
  it.effect(
    "decodes the codes of the tape's trades and the day's complete",
    () =>
      Effect.gen(function* () {
        const fake = browser(
          200,
          '{"codes":[["51",{"buyer":"AK","buyerType":"F","seller":"CD","sellerType":"D"}]],"complete":false}'
        )
        assert.deepStrictEqual(yield* brokerCodesFrom(fake), {
          codes: [
            [
              TradeNumber.make("51"),
              {
                buyer: BrokerCode.make("AK"),
                buyerType: "F",
                seller: BrokerCode.make("CD"),
                sellerType: "D",
              },
            ],
          ],
          complete: false,
        })
        assert.deepStrictEqual(fake.asked, [
          {
            url: "http://dashboard.test/market-live/days/2026-11-09/broker-codes?at=1794189600000",
          },
        ])
      })
  )

  it.effect("fresh asks past the browser's copy", () =>
    Effect.gen(function* () {
      const fake = browser(200, '{"codes":[],"complete":true}')
      assert.deepStrictEqual(yield* brokerCodesFrom(fake, true), {
        codes: [],
        complete: true,
      })
      assert.strictEqual(fake.asked[0]?.cache, "reload")
    })
  )

  it.effect("a 404 is a day with no codes yet", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* brokerCodesFrom(browser(404, "")), {
        codes: [],
        complete: false,
      })
    })
  )

  it.effect("a 401 fails SignInRequired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(brokerCodesFrom(browser(401, "")))
      assert.strictEqual(error._tag, "SignInRequired")
    })
  )
})

// The day strip's answer, listing DAY, cold when `cold` says so; none for
// any other GET. The strip is read on each GET, past any copy.
const stripAnswer = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  cold: boolean
) =>
  url.pathname === "/market-live/days"
    ? Option.some(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              days: [
                { day: DAY, trades: 10, gap: false, ...(cold ? { cold } : {}) },
              ],
            })
          )
        )
      )
    : Option.none()

// A Worker answering each broker codes GET after `delay`, with trade 51's
// buyer named by the cursor's second (BK at second 1, CK at 2) and the day complete from the
// `completeFrom`th GET on, its first `failing` GETs answered 503; it records
// each cursor asked and whether the GET went past the browser's copy. Its
// day strip says the day is cold when `cold` does, or once `turnCold` ran.
const codesWorker = ({
  delay = () => Duration.zero,
  completeFrom = Number.POSITIVE_INFINITY,
  failing = 0,
  cold = false,
}: {
  delay?: (at: number) => Duration.Duration
  completeFrom?: number
  failing?: number
  cold?: boolean
}) => {
  const asked: Array<{ readonly at: number; readonly fresh: boolean }> = []
  let coldNow = cold
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const strip = stripAnswer(request, url, coldNow)
      if (Option.isSome(strip)) return strip.value
      const at = Number(url.searchParams.get("at"))
      const fresh = Option.isSome(
        yield* Effect.serviceOption(FetchHttpClient.RequestInit)
      )
      asked.push({ at, fresh })
      const complete = asked.length >= completeFrom
      yield* Effect.sleep(delay(at))
      if (asked.length <= failing)
        return HttpClientResponse.fromWeb(
          request,
          new Response("Worker failing", { status: 503 })
        )
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            codes: [
              [
                "51",
                {
                  buyer: `${"ABCDEFGHIJ"[(at / 1_000) % 60]}K`,
                  buyerType: "F",
                  seller: "CD",
                  sellerType: "D",
                },
              ],
            ],
            complete,
          })
        )
      )
    })
  ).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://dashboard.test"))
  )
  const turnCold = () => {
    coldNow = true
  }
  return { asked, client, turnCold }
}

const second = (n: number) => DateTime.add(MINUTE, { seconds: n })

// Trade 51's buyer in each answer shown.
const buyersShown = (shown: ReadonlyArray<RecordedTradeCodes>) =>
  shown.map(
    (codes): string | undefined => codes.get(TradeNumber.make("51"))?.buyer
  )

describe("following a recorded day's broker codes", () => {
  it.effect("an older cursor's answer never overwrites a newer one", () => {
    // The first cursor's answer comes back after the second's.
    const codesFrom = codesWorker({
      delay: (at) =>
        Duration.seconds(at === DateTime.toEpochMillis(second(1)) ? 5 : 1),
    })
    return Effect.gen(function* () {
      const shown: Array<RecordedTradeCodes> = []
      const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
        shown.push(answer)
      )
      yield* Effect.forkChild(codes.ask(second(1)))
      yield* Effect.forkChild(codes.ask(second(2)))
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(buyersShown(shown), ["CK"])
    }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
  })

  it.effect(
    "while incomplete, asks again for the current cursor every 30 s past the browser's copy, and stops once complete",
    () => {
      // The day's codes are complete from the 4th GET on.
      const codesFrom = codesWorker({ completeFrom: 4 })
      return Effect.gen(function* () {
        const shown: Array<RecordedTradeCodes> = []
        const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
          shown.push(answer)
        )
        yield* Effect.forkChild(codes.recheck)
        yield* codes.ask(second(1))
        yield* TestClock.adjust("10 seconds")
        yield* codes.ask(second(2))
        yield* TestClock.adjust("20 seconds")
        assert.deepStrictEqual(codesFrom.asked, [
          { at: DateTime.toEpochMillis(second(1)), fresh: false },
          { at: DateTime.toEpochMillis(second(2)), fresh: false },
          { at: DateTime.toEpochMillis(second(2)), fresh: true },
        ])
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(codesFrom.asked.slice(3), [
          { at: DateTime.toEpochMillis(second(2)), fresh: true },
        ])
        assert.deepStrictEqual(buyersShown(shown), ["BK", "CK", "CK", "CK"])
      }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
    }
  )

  it.effect(
    "never asks again for a cold day, though its codes are incomplete",
    () => {
      const codesFrom = codesWorker({ cold: true })
      return Effect.gen(function* () {
        const codes = yield* makeBrokerCodesFollower(DAY, () => {})
        yield* Effect.forkChild(codes.recheck)
        yield* codes.ask(second(1))
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(codesFrom.asked, [
          { at: DateTime.toEpochMillis(second(1)), fresh: false },
        ])
      }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
    }
  )

  it.effect(
    "a cold day's failed first ask is asked again by the recheck",
    () => {
      const codesFrom = codesWorker({ failing: 1, cold: true })
      return Effect.gen(function* () {
        const shown: Array<RecordedTradeCodes> = []
        const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
          shown.push(answer)
        )
        yield* Effect.forkChild(codes.recheck)
        yield* Effect.exit(codes.ask(second(1)))
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(codesFrom.asked, [
          { at: DateTime.toEpochMillis(second(1)), fresh: false },
          { at: DateTime.toEpochMillis(second(1)), fresh: true },
        ])
        assert.deepStrictEqual(buyersShown(shown), ["BK"])
      }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
    }
  )

  it.effect(
    "asks again for a day the strip names hot, and once more past the browser's copy when a later strip names it cold",
    () => {
      const codesFrom = codesWorker({})
      return Effect.gen(function* () {
        const shown: Array<RecordedTradeCodes> = []
        const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
          shown.push(answer)
        )
        yield* Effect.forkChild(codes.recheck)
        yield* codes.ask(second(1))
        yield* TestClock.adjust("30 seconds")
        codesFrom.turnCold()
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(codesFrom.asked, [
          { at: DateTime.toEpochMillis(second(1)), fresh: false },
          { at: DateTime.toEpochMillis(second(1)), fresh: true },
          { at: DateTime.toEpochMillis(second(1)), fresh: true },
        ])
        assert.deepStrictEqual(buyersShown(shown), ["BK", "BK", "BK"])
      }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
    }
  )

  it.effect(
    "asks once more past the browser's copy for a day that turns cold as its answer comes back",
    () => {
      const codesFrom = codesWorker({ delay: () => Duration.seconds(5) })
      return Effect.gen(function* () {
        const shown: Array<RecordedTradeCodes> = []
        const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
          shown.push(answer)
        )
        yield* Effect.forkChild(codes.recheck)
        yield* Effect.forkChild(codes.ask(second(1)))
        yield* TestClock.adjust("1 second")
        codesFrom.turnCold()
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(codesFrom.asked, [
          { at: DateTime.toEpochMillis(second(1)), fresh: false },
          { at: DateTime.toEpochMillis(second(1)), fresh: true },
        ])
        assert.deepStrictEqual(buyersShown(shown), ["BK", "BK"])
      }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
    }
  )

  it.effect("a failed first ask is asked again by the recheck", () => {
    const codesFrom = codesWorker({ completeFrom: 2, failing: 1 })
    return Effect.gen(function* () {
      const shown: Array<RecordedTradeCodes> = []
      const codes = yield* makeBrokerCodesFollower(DAY, (answer) =>
        shown.push(answer)
      )
      yield* Effect.forkChild(codes.recheck)
      yield* Effect.exit(codes.ask(second(1)))
      yield* TestClock.adjust("30 seconds")
      yield* TestClock.adjust("5 minutes")
      assert.deepStrictEqual(codesFrom.asked, [
        { at: DateTime.toEpochMillis(second(1)), fresh: false },
        { at: DateTime.toEpochMillis(second(1)), fresh: true },
      ])
      assert.deepStrictEqual(buyersShown(shown), ["BK"])
    }).pipe(Effect.provideService(HttpClient.HttpClient, codesFrom.client))
  })
})

// A Worker answering each sweep brokers GET of BBCA with one more whole sweep
// than the last, the day complete from the `completeFrom`th GET on, and its
// first `failing` GETs answered 503; it records whether each GET went past
// the browser's copy. Its day strip says the day is cold once `coldAfter`
// GETs were answered (0: from the start), or once `turnCold` ran.
const sweepBrokersWorker = (
  completeFrom: number,
  failing = 0,
  coldAfter = Number.POSITIVE_INFINITY
) => {
  const asked: Array<boolean> = []
  let coldNow = false
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const strip = stripAnswer(
        request,
        url,
        coldNow || asked.length >= coldAfter
      )
      if (Option.isSome(strip)) return strip.value
      asked.push(
        Option.isSome(yield* Effect.serviceOption(FetchHttpClient.RequestInit))
      )
      if (asked.length <= failing)
        return HttpClientResponse.fromWeb(
          request,
          new Response("Worker failing", { status: 503 })
        )
      const sweeps = asked.map((_, index) => [String(index + 1), []])
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            code: "BBCA",
            sweeps,
            complete: asked.length >= completeFrom,
          })
        )
      )
    })
  ).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://dashboard.test"))
  )
  const turnCold = () => {
    coldNow = true
  }
  return { asked, client, turnCold }
}

describe("following a recorded day's sweep brokers", () => {
  it.effect(
    "while incomplete, asks again every 30 s past the browser's copy, and stops once complete",
    () => {
      const brokersFrom = sweepBrokersWorker(3)
      return Effect.gen(function* () {
        const shown: Array<
          [sweeps: number, complete: boolean, asksAgain: boolean]
        > = []
        yield* Effect.forkChild(
          followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
            shown.push([answer.sweeps.length, answer.complete, asksAgain])
          )
        )
        yield* TestClock.adjust("29 seconds")
        assert.deepStrictEqual(brokersFrom.asked, [false])
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(brokersFrom.asked, [false, true])
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(brokersFrom.asked, [false, true, true])
        assert.deepStrictEqual(shown, [
          [1, false, true],
          [2, false, true],
          [3, true, false],
        ])
      }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
    }
  )

  it.effect("a failed first ask is asked again 30 s later", () => {
    const brokersFrom = sweepBrokersWorker(2, 1)
    return Effect.gen(function* () {
      const shown: Array<
        [sweeps: number, complete: boolean, asksAgain: boolean]
      > = []
      yield* Effect.forkChild(
        followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
          shown.push([answer.sweeps.length, answer.complete, asksAgain])
        )
      )
      yield* TestClock.adjust("30 seconds")
      yield* TestClock.adjust("5 minutes")
      assert.deepStrictEqual(brokersFrom.asked, [false, true])
      assert.deepStrictEqual(shown, [[2, true, false]])
    }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
  })

  it.effect("a 401 on the first ask ends it with SignInRequired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(followSweepBrokers(DAY, BBCA, () => {}))
      assert.strictEqual(error._tag, "SignInRequired")
    }).pipe(Effect.provideService(HttpClient.HttpClient, worker(401)))
  )

  it.effect("asks once for a cold day, though its codes are incomplete", () => {
    const brokersFrom = sweepBrokersWorker(Number.POSITIVE_INFINITY, 0, 0)
    return Effect.gen(function* () {
      const shown: Array<
        [sweeps: number, complete: boolean, asksAgain: boolean]
      > = []
      yield* Effect.forkChild(
        followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
          shown.push([answer.sweeps.length, answer.complete, asksAgain])
        )
      )
      yield* TestClock.adjust("5 minutes")
      assert.deepStrictEqual(brokersFrom.asked, [false])
      assert.deepStrictEqual(shown, [[1, false, false]])
    }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
  })

  it.effect("a cold day's failed first ask is asked again 30 s later", () => {
    const brokersFrom = sweepBrokersWorker(Number.POSITIVE_INFINITY, 1, 0)
    return Effect.gen(function* () {
      const shown: Array<
        [sweeps: number, complete: boolean, asksAgain: boolean]
      > = []
      yield* Effect.forkChild(
        followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
          shown.push([answer.sweeps.length, answer.complete, asksAgain])
        )
      )
      yield* TestClock.adjust("30 seconds")
      yield* TestClock.adjust("5 minutes")
      assert.deepStrictEqual(brokersFrom.asked, [false, true])
      assert.deepStrictEqual(shown, [[2, false, false]])
    }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
  })

  it.effect(
    "asks again for a day the strip names hot, until a later strip names it cold",
    () => {
      const brokersFrom = sweepBrokersWorker(Number.POSITIVE_INFINITY)
      return Effect.gen(function* () {
        const shown: Array<
          [sweeps: number, complete: boolean, asksAgain: boolean]
        > = []
        yield* Effect.forkChild(
          followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
            shown.push([answer.sweeps.length, answer.complete, asksAgain])
          )
        )
        yield* TestClock.adjust("10 seconds")
        brokersFrom.turnCold()
        yield* TestClock.adjust("20 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(brokersFrom.asked, [false, true])
        assert.deepStrictEqual(shown, [
          [1, false, true],
          [2, false, false],
        ])
      }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
    }
  )

  it.effect(
    "asks once more past the browser's copy for a day that turns cold as its answer comes back",
    () => {
      const brokersFrom = sweepBrokersWorker(Number.POSITIVE_INFINITY, 0, 1)
      return Effect.gen(function* () {
        const shown: Array<
          [sweeps: number, complete: boolean, asksAgain: boolean]
        > = []
        yield* Effect.forkChild(
          followSweepBrokers(DAY, BBCA, (answer, asksAgain) =>
            shown.push([answer.sweeps.length, answer.complete, asksAgain])
          )
        )
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(brokersFrom.asked, [false, true])
        assert.deepStrictEqual(shown, [
          [1, false, true],
          [2, false, false],
        ])
      }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
    }
  )

  it.effect("asks once for a day already complete", () => {
    const brokersFrom = sweepBrokersWorker(1)
    return Effect.gen(function* () {
      yield* Effect.forkChild(followSweepBrokers(DAY, BBCA, () => {}))
      yield* TestClock.adjust("5 minutes")
      assert.deepStrictEqual(brokersFrom.asked, [false])
    }).pipe(Effect.provideService(HttpClient.HttpClient, brokersFrom.client))
  })
})

describe("a recorded day's GETs", () => {
  it.effect("a 404 means the code had no book by then", () =>
    Effect.gen(function* () {
      const chunk = yield* bookChunkFrom(404)
      assert.isTrue(Option.isNone(chunk))
    })
  )

  it.effect("a 401 fails SignInRequired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(bookChunkFrom(401))
      assert.strictEqual(error._tag, "SignInRequired")
    })
  )

  for (const status of [500, 503])
    it.effect(`a ${status} fails rather than answering no book`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(bookChunkFrom(status))
        assert.strictEqual(error._tag, "HttpClientError")
      })
    )
})
