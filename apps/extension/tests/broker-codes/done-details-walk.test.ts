import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  StockCode,
  TradeNumber,
  WibDate,
  type BrokerCodesBatch,
  type OrderNumbers,
} from "@workspace/relay"
import { Clock, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import {
  makeDoneDetailsWalk,
  type DetailRow,
  type DoneDetailsPosition,
  type DoneDetailsStore,
  type KeptTrade,
} from "../../src/worker/broker-codes/done-details-walk.ts"
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"
import hope from "./fixtures/done-details-hope-2026-11-20.json"

const DAY = WibDate.make("2026-11-20")
const wib = (time: string) => Date.parse(`2026-11-20T${time}+07:00`)

// HOPE's 1,312 trades on 2026-11-20 as Stockbit's tape gave them, with the
// order numbers and side Stockbit read, and Ajaib's 1,311 Done Details rows
// of the same day, both captured after the close (research branch
// `research/order-number-routes`, docs/research/order-number-captures).
type HopeTrade = (typeof hope.trades)[number]
const tradeOf = (trade: HopeTrade): KeptTrade => ({
  number: TradeNumber.make(String(trade[0])),
  code: StockCode.make("HOPE"),
  second: String(trade[1]),
  board: trade[2] as KeptTrade["board"],
  price: Number(trade[3]),
  lots: Number(trade[4]),
  codes: {
    buyer: BrokerCode.make(String(trade[5])),
    buyerType: trade[6] as "D" | "F",
    seller: BrokerCode.make(String(trade[7])),
    sellerType: trade[8] as "D" | "F",
  },
})
const HOPE_TRADES = hope.trades.map(tradeOf)
// Stockbit's order numbers and side, by trade number.
const STOCKBIT = new Map(
  hope.trades.map((trade) => [
    String(trade[0]),
    {
      orders: [Number(trade[9]), Number(trade[10])] as const,
      side: String(trade[11]),
    },
  ])
)

// An Ajaib Done Details row as the route answers it; `is_highlighted`
// marks the buyer on every row, which is not its side.
type Detail = (typeof hope.details)[number]
const detailRow = (row: Detail) => ({
  time: row[0],
  code: row[1],
  board: row[2],
  price: row[3],
  qty: row[4],
  amount: Number(row[3]) * Number(row[4]) * 100,
  buyer: {
    type: "D",
    order_id: row[6],
    broker_code: row[5],
    is_highlighted: true,
  },
  seller: {
    type: "D",
    order_id: row[8],
    broker_code: row[7],
    is_highlighted: false,
  },
})
const HOPE_DETAILS = hope.details.map(detailRow)

const OK = (body: unknown): Answer => ({
  _tag: "answer",
  id: 0,
  status: 200,
  body: JSON.stringify(body),
})

const DETAILS_PATH = "v1/stock/data/broker-transaction"
const paramOf = (path: string, name: string) =>
  new URL(path, "https://ht2.ajaib.co.id/api/").searchParams.get(name)

// Ajaib's Done Details route: each code's rows, `page_size` at a time, with
// `has_next` while more follow.
const fakeAjaib = (
  options: {
    readonly details?: Readonly<Record<string, ReadonlyArray<unknown>>>
    // Overrides the answer to a call, by its 1-based index.
    readonly answer?: (call: number) => Option.Option<Answer> | undefined
  } = {}
) => {
  const details = options.details ?? { HOPE: HOPE_DETAILS }
  const paths: Array<string> = []
  return {
    paths,
    attached: Effect.succeed(true),
    reload: Effect.void,
    request: (request: TabRequest) =>
      Effect.sync(() => {
        if (request._tag === "page-token")
          return Option.some<Answer>({ ...OK(""), body: "token" })
        if (request._tag !== "page-fetch") return Option.none<Answer>()
        paths.push(request.path)
        const override = options.answer?.(paths.length)
        if (override !== undefined) return override
        const rows = details[paramOf(request.path, "code") ?? ""] ?? []
        const page = Number(paramOf(request.path, "page"))
        const size = Number(paramOf(request.path, "page_size"))
        const answered = rows.slice((page - 1) * size, page * size)
        return Option.some(
          OK({
            err_code: "EC0000000",
            result: {
              market_date: paramOf(request.path, "market_date"),
              count: answered.length,
              has_next: page * size < rows.length,
              transactions: answered,
            },
          })
        )
      }),
  }
}

// The browser's kept trades and the walk's place, as the worker keeps them
// across restarts.
const memoryStore = () => {
  let day = Option.none<WibDate>()
  let trades: Array<KeptTrade> = []
  let position = Option.none<DoneDetailsPosition>()
  let rows: Array<DetailRow> = []
  const store: DoneDetailsStore = {
    keep: (of, kept) =>
      Effect.sync(() => {
        if (!Option.contains(day, of)) {
          trades = []
          position = Option.none()
          rows = []
        }
        day = Option.some(of)
        const numbers = new Set(kept.map((trade) => trade.number))
        trades = [
          ...trades.filter((trade) => !numbers.has(trade.number)),
          ...kept,
        ]
      }),
    codes: (of) =>
      Effect.sync(() =>
        Option.contains(day, of)
          ? [...new Set(trades.map((trade) => trade.code))].sort()
          : []
      ),
    trades: (of, code) =>
      Effect.sync(() =>
        Option.contains(day, of)
          ? trades.filter((trade) => trade.code === code)
          : []
      ),
    position: (of) =>
      Effect.sync(() => (Option.contains(day, of) ? position : Option.none())),
    rows: (of, code) =>
      Effect.sync(() =>
        Option.contains(day, of) &&
        Option.exists(position, (at) => at.code === code)
          ? rows
          : []
      ),
    page: (of, next, fetched) =>
      Effect.sync(() => {
        if (!Option.contains(day, of)) return
        if (!Option.exists(position, (at) => at.code === next.code)) rows = []
        rows = [...rows, ...fetched]
        position = Option.some(next)
      }),
    clear: Effect.sync(() => {
      day = Option.none()
      trades = []
      position = Option.none()
      rows = []
    }),
  }
  return { store, position: () => position }
}

const keptStore = (trades: ReadonlyArray<KeptTrade> = HOPE_TRADES) =>
  Effect.gen(function* () {
    const memory = memoryStore()
    yield* memory.store.keep(DAY, trades)
    return memory
  })

const fakeProduction = () => {
  const batches: Array<BrokerCodesBatch> = []
  return {
    batches,
    post: (batch: BrokerCodesBatch) =>
      Effect.sync((): PostOutcome => {
        batches.push(batch)
        return "sent"
      }),
    // Each posted trade's order numbers.
    orders: () =>
      new Map(
        batches.flatMap((batch) =>
          batch.rows.flatMap(([number, , , orders]) =>
            orders === undefined ? [] : [[String(number), orders] as const]
          )
        )
      ),
  }
}

const walkWith = (
  tab: ReturnType<typeof fakeAjaib>,
  store: DoneDetailsStore,
  production = fakeProduction()
) => makeDoneDetailsWalk({ tab, post: production.post, store })

const evening = TestClock.setTime(wib("17:30:00"))

describe("the Done Details walk", () => {
  it.effect(
    "gives 1,311 of HOPE's 1,312 trades Ajaib's order numbers, as Stockbit reads them",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore()
        const production = fakeProduction()
        const tab = fakeAjaib()
        const walk = yield* walkWith(tab, store, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        const orders = production.orders()
        assert.strictEqual(orders.size, 1_311)
        // Tied trades (same second, board, price, lots and brokers) take
        // their key's orders in any order, so each key's set is compared.
        const ties = new Map<string, Array<string>>()
        for (const trade of HOPE_TRADES) {
          const tie = JSON.stringify([
            trade.second,
            trade.board,
            trade.price,
            trade.lots,
            trade.codes.buyer,
            trade.codes.seller,
          ])
          ties.set(tie, [...(ties.get(tie) ?? []), trade.number])
        }
        const sorted = (all: ReadonlyArray<unknown>) =>
          all.map((each) => JSON.stringify(each)).sort()
        for (const numbers of ties.values()) {
          const posted = numbers.flatMap((number) =>
            Option.toArray(Option.fromNullishOr(orders.get(number)))
          )
          if (posted.length === 0) continue
          assert.deepStrictEqual(
            sorted(posted),
            sorted(numbers.map((number) => STOCKBIT.get(number)?.orders))
          )
        }
        // The one RG trade Ajaib's route doesn't list.
        const unmatched = HOPE_TRADES.filter(
          (trade) => !orders.has(trade.number)
        )
        assert.deepStrictEqual(
          unmatched.map((trade) => trade.second),
          ["09:47:59"]
        )
        // Two pages of 1,000 for HOPE.
        assert.deepStrictEqual(
          tab.paths.map((path) => [
            path.split("?")[0],
            paramOf(path, "code"),
            paramOf(path, "market_date"),
            paramOf(path, "page"),
            paramOf(path, "page_size"),
          ]),
          [
            [DETAILS_PATH, "HOPE", DAY, "1", "1000"],
            [DETAILS_PATH, "HOPE", DAY, "2", "1000"],
          ]
        )
      })
  )

  it.effect(
    "posts each trade's codes and buy and sell order numbers, the larger its aggressor's",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore()
        const production = fakeProduction()
        const walk = yield* walkWith(fakeAjaib(), store, production)
        yield* walk.walk(DAY)
        const codes = new Map(
          HOPE_TRADES.map((trade) => [trade.number, trade.codes])
        )
        for (const batch of production.batches) {
          assert.strictEqual(batch.feed, "Ajaib")
          assert.strictEqual(batch.day, DAY)
          assert.isAtMost(batch.rows.length, 5_000)
          for (const [number, posted, fields, orders] of batch.rows) {
            assert.deepStrictEqual(posted, codes.get(number))
            assert.isNull(fields)
            const [buy, sell] = orders as OrderNumbers
            const side = STOCKBIT.get(number)?.side
            if (side === "buy") assert.isAbove(buy, sell)
            if (side === "sell") assert.isAbove(sell, buy)
          }
        }
      })
  )

  it.effect("matches the auctions' HH:mm rows as their :00 second", () =>
    Effect.gen(function* () {
      yield* evening
      const { store } = yield* keptStore()
      const production = fakeProduction()
      const walk = yield* walkWith(fakeAjaib(), store, production)
      yield* walk.walk(DAY)
      const orders = production.orders()
      const auctions = HOPE_TRADES.filter((trade) =>
        ["08:58:00", "16:00:00"].includes(trade.second)
      )
      assert.isAbove(auctions.length, 0)
      for (const trade of auctions) assert.isTrue(orders.has(trade.number))
    })
  )

  it.effect("assigns nothing to a key whose row and trade counts differ", () =>
    Effect.gen(function* () {
      yield* evening
      // 15:48:34's XL from YP at 170 for 213 lots is one trade; Ajaib lists
      // it twice.
      const at = HOPE_DETAILS.findIndex(
        (row) => row.time === "15:48:34" && row.qty === 213
      )
      assert.isAtLeast(at, 0)
      const twice = [...HOPE_DETAILS, HOPE_DETAILS[at]]
      const { store } = yield* keptStore()
      const production = fakeProduction()
      const walk = yield* walkWith(
        fakeAjaib({ details: { HOPE: twice } }),
        store,
        production
      )
      yield* walk.walk(DAY)
      const orders = production.orders()
      assert.strictEqual(orders.size, 1_310)
      const doubled = HOPE_TRADES.filter(
        (trade) => trade.second === "15:48:34" && trade.lots === 213
      )
      assert.lengthOf(doubled, 1)
      assert.isFalse(orders.has(doubled[0]!.number))
    })
  )

  it.effect(
    "walks every kept code, says how many it has done, then forgets the kept trades",
    () =>
      Effect.gen(function* () {
        yield* evening
        const bbca: KeptTrade = {
          ...HOPE_TRADES[0]!,
          number: TradeNumber.make("1"),
          code: StockCode.make("BBCA"),
        }
        const memory = yield* keptStore([...HOPE_TRADES, bbca])
        const done: Array<[number, number]> = []
        const tab = fakeAjaib()
        const walk = yield* makeDoneDetailsWalk({
          tab,
          post: fakeProduction().post,
          store: memory.store,
          codes: (count, of) =>
            Effect.sync(() => {
              done.push([count, of])
            }),
        })
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          tab.paths.map((path) => paramOf(path, "code")),
          ["BBCA", "HOPE", "HOPE"]
        )
        assert.deepStrictEqual(done, [
          [0, 2],
          [1, 2],
          [2, 2],
        ])
        assert.deepStrictEqual(yield* memory.store.codes(DAY), [])
      })
  )

  it.effect("walks no day whose trades this browser didn't keep", () =>
    Effect.gen(function* () {
      yield* evening
      const { store } = yield* keptStore()
      const tab = fakeAjaib()
      const production = fakeProduction()
      const walk = yield* walkWith(tab, store, production)
      assert.deepStrictEqual(yield* walk.walk(WibDate.make("2026-11-19")), {
        _tag: "walked",
      })
      assert.deepStrictEqual(tab.paths, [])
      assert.deepStrictEqual(production.batches, [])
    })
  )

  it.effect(
    "resumes at its stored code and page after a restart, matching every page",
    () =>
      Effect.gen(function* () {
        yield* evening
        const memory = yield* keptStore()
        // The first worker's tab stops answering after HOPE's first page.
        const first = fakeAjaib({
          answer: (call) => (call >= 2 ? Option.none() : undefined),
        })
        const firstWalk = yield* walkWith(first, memory.store)
        const fiber = yield* Effect.forkChild(firstWalk.walk(DAY))
        for (let turn = 0; turn < 100 && first.paths.length < 2; turn++)
          yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(
          memory.position(),
          Option.some({ code: StockCode.make("HOPE"), page: 2 })
        )
        // A restarted worker's walk asks HOPE's second page first.
        const production = fakeProduction()
        const second = fakeAjaib()
        const secondWalk = yield* walkWith(second, memory.store, production)
        assert.deepStrictEqual(yield* secondWalk.walk(DAY), {
          _tag: "walked",
        })
        assert.deepStrictEqual(
          second.paths.map((path) => paramOf(path, "page")),
          ["2"]
        )
        assert.strictEqual(production.orders().size, 1_311)
      })
  )

  it.effect(
    "past Ajaib's window, leaves the day to Stockbit and forgets its kept trades",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-21T00:30:00+07:00"))
        const memory = yield* keptStore()
        const tab = fakeAjaib()
        const walk = yield* walkWith(tab, memory.store)
        assert.deepStrictEqual(yield* walk.walk(DAY), {
          _tag: "unserved",
          reason: "window-passed",
        })
        assert.deepStrictEqual(tab.paths, [])
        assert.deepStrictEqual(yield* memory.store.codes(DAY), [])
      })
  )

  it.effect("retries a page Ajaib didn't answer every 10 s, in place", () =>
    Effect.gen(function* () {
      yield* evening
      const { store } = yield* keptStore()
      const production = fakeProduction()
      const tab = fakeAjaib({
        answer: (call) => (call === 1 ? Option.none() : undefined),
      })
      const walk = yield* walkWith(tab, store, production)
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* TestClock.adjust("0 millis")
      assert.lengthOf(tab.paths, 1)
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
      assert.deepStrictEqual(
        tab.paths.map((path) => paramOf(path, "page")),
        ["1", "1", "2"]
      )
      assert.strictEqual(production.orders().size, 1_311)
      assert.isAtLeast(yield* Clock.currentTimeMillis, wib("17:30:10"))
    })
  )
})
