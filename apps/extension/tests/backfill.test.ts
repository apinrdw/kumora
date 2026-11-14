import { assert, describe, it } from "@effect/vitest"
import { TradeNumber, type IngestUp } from "@workspace/relay"
import { DateTime, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeBackfill } from "../src/worker/backfill.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"
import { makePacer } from "../src/worker/pacer.ts"
import type { TargetName } from "../src/worker/settings.ts"

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("=", "")
// The Stockbit tab's access token: a JWT naming user 7.
const TOKEN = `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 7 } })}.sig`

// A broker tab that answers each request with what `answer` returns for it,
// and keeps every request.
const fakeTab = (answer: (request: TabRequest) => Answer | undefined) => {
  const requests: Array<TabRequest> = []
  return {
    requests,
    request: (request: TabRequest) =>
      Effect.sync(() => {
        requests.push(request)
        if (request._tag === "cookie")
          return Option.some<Answer>({
            _tag: "answer",
            id: 0,
            status: 200,
            body: encodeURIComponent(JSON.stringify({ token: TOKEN })),
          })
        return Option.fromNullishOr(answer(request))
      }),
  }
}

const ok = (body: unknown): Answer => ({
  _tag: "answer",
  id: 0,
  status: 200,
  body: JSON.stringify(body),
})

// A Stockbit page of these numbers, newest first.
const stockbitPage = (numbers: ReadonlyArray<number>) =>
  ok({
    data: {
      running_trade: numbers.map((number) => ({
        trade_number: String(number),
      })),
    },
  })

const ajaibPage = (numbers: ReadonlyArray<number>, more: boolean) =>
  ok({
    results: numbers.map((number) => ({
      trade_num: `2026111000${String(number).padStart(8, "0")}`,
    })),
    has_next: more,
  })

// Stockbit's tape before a cursor, `limit` rows newest first, from a market
// where every number up to 30,000 traded.
const stockbitTape = (request: TabRequest) => {
  if (request._tag !== "fetch") return undefined
  const cursor = Number(new URL(request.url).searchParams.get("trade_number"))
  const limit = Number(new URL(request.url).searchParams.get("limit"))
  return stockbitPage(Array.from({ length: limit }, (_, at) => cursor - 1 - at))
}

const cursorsOf = (requests: ReadonlyArray<TabRequest>) =>
  requests.flatMap((request) =>
    request._tag === "fetch"
      ? [new URL(request.url).searchParams.get("trade_number")]
      : []
  )

const pathsOf = (requests: ReadonlyArray<TabRequest>) =>
  requests.flatMap((request) =>
    request._tag === "page-fetch" ? [request.path] : []
  )

// 10:00:00 WIB on 2026-11-10.
const NEXT_TIME = Date.parse("2026-11-10T03:00:00.000Z")

const harness = Effect.fnUntraced(function* (tabs: {
  readonly stockbit: ReturnType<typeof fakeTab>
  readonly ajaib: ReturnType<typeof fakeTab>
}) {
  yield* TestClock.setTime(NEXT_TIME + 5_000)
  const published: Array<IngestUp> = []
  // Each site's calls go through its pacer, as in the service worker. The
  // fake tabs answer every call at once.
  const stockbit = yield* makePacer({
    feed: "Stockbit",
    tab: { ...tabs.stockbit, awaitAnswer: tabs.stockbit.request },
  })
  const ajaib = yield* makePacer({
    feed: "Ajaib",
    tab: { ...tabs.ajaib, awaitAnswer: tabs.ajaib.request },
  })
  const backfill = yield* makeBackfill({
    stockbit: stockbit.tab("backfill"),
    ajaib: ajaib.tab("backfill"),
    publish: (message) => Effect.sync(() => published.push(message)),
  })
  const fiber = yield* Effect.forkChild(
    Effect.all([stockbit.run, ajaib.run, backfill.run], {
      concurrency: "unbounded",
    })
  )
  // The calls start idle, so a request waits for the next call.
  yield* TestClock.adjust("0 millis")
  const ask = (target: TargetName, from: number, to: number) =>
    backfill.request(target, {
      _tag: "Backfill",
      from: TradeNumber.make(String(from)),
      to: TradeNumber.make(String(to)),
      nextTime: DateTime.makeUnsafe(NEXT_TIME),
    })
  const pages = () =>
    published.flatMap((message) =>
      message._tag === "BackfillPage"
        ? [[message.feed, message.from, message.to]]
        : []
    )
  return { ask, pages, stop: Fiber.interrupt(fiber) }
})

describe("backfill from Stockbit", () => {
  it.effect(
    "pages back from the number after the gap until it passes the gap's start, one call a second",
    () =>
      Effect.gen(function* () {
        const stockbit = fakeTab(stockbitTape)
        const ajaib = fakeTab(() => undefined)
        const relay = yield* harness({ stockbit, ajaib })
        yield* relay.ask("production", 20_001, 20_143)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(cursorsOf(stockbit.requests), ["20144"])
        const fetched = stockbit.requests.find(
          (request) => request._tag === "fetch"
        )
        assert.deepStrictEqual(fetched, {
          _tag: "fetch",
          url: "https://exodus.stockbit.com/order-trade/running-trade?sort=DESC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=100&trade_number=20144",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(cursorsOf(stockbit.requests), ["20144", "20044"])
        yield* TestClock.adjust("10 seconds")
        // 20,044 to 19,945 passed 20,001: the gap is covered, nothing more.
        assert.deepStrictEqual(cursorsOf(stockbit.requests), ["20144", "20044"])
        assert.deepStrictEqual(relay.pages(), [
          ["Stockbit", "20001", "20143"],
          ["Stockbit", "20001", "20143"],
        ])
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(ajaib.requests, [])
        yield* relay.stop
      })
  )

  it.effect("gaps one call can cover are fetched together", () =>
    Effect.gen(function* () {
      const stockbit = fakeTab(stockbitTape)
      const relay = yield* harness({
        stockbit,
        ajaib: fakeTab(() => undefined),
      })
      yield* relay.ask("production", 20_010, 20_012)
      yield* relay.ask("production", 20_040, 20_046)
      yield* relay.ask("extra", 20_030, 20_031)
      yield* TestClock.adjust("5 seconds")
      assert.deepStrictEqual(cursorsOf(stockbit.requests), ["20047"])
      assert.deepStrictEqual(relay.pages(), [["Stockbit", "20010", "20046"]])
      yield* relay.stop
    })
  )

  it.effect(
    "Production's ranges go first; the extra target's wait for a spare call",
    () =>
      Effect.gen(function* () {
        const stockbit = fakeTab(stockbitTape)
        const relay = yield* harness({
          stockbit,
          ajaib: fakeTab(() => undefined),
        })
        yield* relay.ask("extra", 25_001, 25_050)
        yield* relay.ask("production", 21_001, 21_050)
        yield* relay.ask("production", 23_001, 23_050)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(cursorsOf(stockbit.requests), ["21051"])
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(cursorsOf(stockbit.requests), ["21051", "23051"])
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(cursorsOf(stockbit.requests), [
          "21051",
          "23051",
          "25051",
        ])
        yield* relay.stop
      })
  )
})

describe("the Ajaib fallback", () => {
  it.effect(
    "takes what Stockbit didn't carry, 2 minutes after the next trade, paging by time while Ajaib has more",
    () =>
      Effect.gen(function* () {
        // Stockbit's page skips 20,005 to 20,007.
        const stockbit = fakeTab(() =>
          stockbitPage([
            20_010, 20_009, 20_008, 20_004, 20_003, 20_002, 20_001, 20_000,
          ])
        )
        const ajaib = fakeTab((request) => {
          if (request._tag !== "page-fetch") return undefined
          const page = new URLSearchParams(request.path.split("?")[1]).get(
            "page"
          )
          return page === "1"
            ? ajaibPage([20_012, 20_011, 20_010, 20_009], true)
            : ajaibPage([20_008, 20_006, 20_004], true)
        })
        const relay = yield* harness({ stockbit, ajaib })
        yield* relay.ask("production", 20_001, 20_009)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(relay.pages(), [["Stockbit", "20001", "20009"]])
        // The next trade was at 10:00:00; Ajaib is asked from 10:02:00.
        yield* TestClock.adjust("113 seconds")
        assert.deepStrictEqual(pathsOf(ajaib.requests), [])
        yield* TestClock.adjust("1 second")
        const at = NEXT_TIME + 1000
        assert.deepStrictEqual(pathsOf(ajaib.requests), [
          `v1/stock/detail/running_trades/?direction=DESC&last_timestamp=${at}&page=1&page_size=40`,
        ])
        // Page 2 passes 20,005: the rest is unfillable and stays so.
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(pathsOf(ajaib.requests), [
          `v1/stock/detail/running_trades/?direction=DESC&last_timestamp=${at}&page=1&page_size=40`,
          `v1/stock/detail/running_trades/?direction=DESC&last_timestamp=${at}&page=2&page_size=40`,
        ])
        assert.deepStrictEqual(relay.pages(), [
          ["Stockbit", "20001", "20009"],
          ["Ajaib", "20005", "20007"],
          ["Ajaib", "20005", "20007"],
        ])
        yield* relay.stop
      })
  )

  it.effect("takes the whole range when the Stockbit tab can't answer", () =>
    Effect.gen(function* () {
      const ajaib = fakeTab(() => ajaibPage([20_003, 20_002, 20_001], false))
      const relay = yield* harness({
        stockbit: fakeTab(() => undefined),
        ajaib,
      })
      yield* relay.ask("extra", 20_001, 20_003)
      yield* TestClock.adjust("3 minutes")
      assert.deepStrictEqual(relay.pages(), [["Ajaib", "20001", "20003"]])
      assert.lengthOf(pathsOf(ajaib.requests), 1)
      yield* relay.stop
    })
  )
})
