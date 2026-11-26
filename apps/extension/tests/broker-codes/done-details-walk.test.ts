import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  OrderNumber,
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
  type MatchedTrade,
  type TapeTrade,
} from "../../src/worker/broker-codes/done-details-walk.ts"
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"
import hope from "./fixtures/done-details-hope-2026-11-20.json"

const DAY = WibDate.make("2026-11-20")
const orderPair = (buy: number, sell: number) =>
  [OrderNumber.make(buy), OrderNumber.make(sell)] as const
const wib = (time: string) => Date.parse(`2026-11-20T${time}+07:00`)

// HOPE's 1,312 trades on 2026-11-20 as Stockbit's tape gave them, with the
// order numbers and side Stockbit read, and Ajaib's 1,311 Done Details rows
// of the same day with each side's investor type, both captured after the close (research branch
// `research/order-number-routes`, docs/research/order-number-captures).
type HopeTrade = (typeof hope.trades)[number]
const tradeOf = (trade: HopeTrade): KeptTrade => ({
  _tag: "Kept",
  number: TradeNumber.make(String(trade[0])),
  code: StockCode.make("HOPE"),
  second: String(trade[1]),
  board: trade[2] as KeptTrade["board"],
  price: Number(trade[3]),
  lots: Number(trade[4]),
  side: trade[11] as KeptTrade["side"],
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

// An Ajaib Done Details row as the route answers it, each side's `type`
// its investor type; `is_highlighted` marks the buyer on every row, which
// is not its side.
type Detail = (typeof hope.details)[number]
const detailRow = (row: Detail) => ({
  time: row[0],
  code: row[1],
  board: row[2],
  price: row[3],
  qty: row[4],
  amount: Number(row[3]) * Number(row[4]) * 100,
  buyer: {
    type: row[6],
    order_id: row[7],
    broker_code: row[5],
    is_highlighted: true,
  },
  seller: {
    type: row[9],
    order_id: row[10],
    broker_code: row[8],
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
    // The `trade_access_token` cookie's raw value; none without one.
    readonly cookie?: () => string
    // Overrides the answer to a call, by its 1-based index and its bearer.
    readonly answer?: (
      call: number,
      bearer: string | undefined
    ) => Option.Option<Answer> | undefined
  } = {}
) => {
  const details = options.details ?? { HOPE: HOPE_DETAILS }
  const paths: Array<string> = []
  const bearers: Array<string | undefined> = []
  return {
    paths,
    bearers,
    attached: Effect.succeed(true),
    reload: Effect.void,
    request: (request: TabRequest) =>
      Effect.sync(() => {
        if (request._tag === "page-token")
          return Option.some<Answer>({ ...OK(""), body: "token" })
        if (request._tag === "cookie" && options.cookie !== undefined)
          return Option.some<Answer>({ ...OK(""), body: options.cookie() })
        if (request._tag !== "page-fetch") return Option.none<Answer>()
        paths.push(request.path)
        bearers.push(request.bearer)
        const override = options.answer?.(paths.length, request.bearer)
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
// across restarts. The tape walk read every other trade of the day with a
// stock code, kept or another code's, but those numbered in `unread`.
const memoryStore = (unread: ReadonlyArray<number> = []) => {
  let day = Option.none<WibDate>()
  let trades: Array<TapeTrade> = []
  let position = Option.none<DoneDetailsPosition>()
  let rows: Array<DetailRow> = []
  let matched = new Map<number, MatchedTrade>()
  const forget = () => {
    trades = []
    position = Option.none()
    rows = []
    matched = new Map()
  }
  const store: DoneDetailsStore = {
    keep: (of, kept) =>
      Effect.sync(() => {
        if (!Option.contains(day, of)) forget()
        day = Option.some(of)
        const held = new Map(trades.map((trade) => [trade.number, trade]))
        for (const trade of kept)
          if (trade._tag === "Kept" || !held.has(trade.number))
            held.set(trade.number, trade)
        trades = [...held.values()].sort(
          (a, b) => Number(a.number) - Number(b.number)
        )
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
    read: (of, from, to) =>
      Effect.sync(() =>
        Option.contains(day, of)
          ? Number(to) -
            Number(from) +
            1 -
            unread.filter((n) => n >= Number(from) && n <= Number(to)).length
          : 0
      ),
    position: (of) =>
      Effect.sync(() => (Option.contains(day, of) ? position : Option.none())),
    rows: (of, code) =>
      Effect.sync(() =>
        Option.contains(day, of) &&
        Option.exists(
          position,
          (at) => at._tag === "Walking" && at.code === code
        )
          ? rows
          : []
      ),
    page: (of, next, fetched) =>
      Effect.sync(() => {
        if (!Option.contains(day, of)) return
        if (next._tag !== "Walking" || next.page === 1) rows = []
        if (next._tag === "Posted") trades = []
        rows = [...rows, ...fetched]
        position = Option.some(next)
      }),
    match: (of, found) =>
      Effect.sync(() => {
        if (!Option.contains(day, of)) return
        for (const trade of found) matched.set(Number(trade.number), trade)
      }),
    matched: (of, after, limit) =>
      Effect.sync(() =>
        Option.contains(day, of)
          ? [...matched.entries()]
              .filter(([number]) =>
                Option.match(after, {
                  onNone: () => true,
                  onSome: (last) => number > Number(last),
                })
              )
              .sort(([a], [b]) => a - b)
              .slice(0, limit)
              .map(([, trade]) => trade)
          : []
      ),
    clear: Effect.sync(() => {
      day = Option.none()
      forget()
    }),
  }
  return { store, position: () => position }
}

const keptStore = (
  trades: ReadonlyArray<TapeTrade> = HOPE_TRADES,
  unread: ReadonlyArray<number> = []
) =>
  Effect.gen(function* () {
    const memory = memoryStore(unread)
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

// A market of 40 codes trading in turn from 09:00:00 to 15:50, 500 trades
// each, every trade's buy and sell order numbers on its Done Details row.
const MARKET_CODES = Array.from({ length: 40 }, (_, at) =>
  StockCode.make(`C${String(at).padStart(3, "0")}`)
)
const MARKET_TRADES = Array.from({ length: 20_000 }, (_, at): KeptTrade => {
  const n = at + 1
  const seconds = 9 * 3_600 + Math.floor((at * 24_600) / 20_000)
  const clock = [seconds / 3_600, (seconds / 60) % 60, seconds % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":")
  return {
    ...HOPE_TRADES[1]!,
    number: TradeNumber.make(String(n)),
    code: MARKET_CODES[n % MARKET_CODES.length]!,
    second: clock,
    price: 1_000 + (n % MARKET_CODES.length),
    lots: 1 + (n % 7),
    side: n % 2 === 0 ? "buy" : "sell",
  }
})
const marketDetails = () => {
  const details: Record<string, Array<unknown>> = {}
  for (const trade of MARKET_TRADES) {
    const n = Number(trade.number)
    const [buy, sell] =
      trade.side === "buy" ? [2 * n + 1, 2 * n] : [2 * n, 2 * n + 1]
    const id = (order: number) => `20261120${String(order).padStart(10, "0")}`
    details[trade.code] = [
      ...(details[trade.code] ?? []),
      {
        ...HOPE_DETAILS[0]!,
        time: trade.second,
        code: trade.code,
        board: trade.board,
        price: trade.price,
        qty: trade.lots,
        buyer: {
          ...HOPE_DETAILS[0]!.buyer,
          type: trade.codes.buyerType,
          order_id: id(buy),
          broker_code: trade.codes.buyer,
        },
        seller: {
          ...HOPE_DETAILS[0]!.seller,
          type: trade.codes.sellerType,
          order_id: id(sell),
          broker_code: trade.codes.seller,
        },
      },
    ]
  }
  return details
}

// BBCA's trades at 10:23:18 tied on one key (board, price, lots and
// brokers), each numbered and sided, and their Done Details rows by buy and
// sell order.
const tied = (number: string, side: KeptTrade["side"]): KeptTrade => ({
  ...HOPE_TRADES[1]!,
  number: TradeNumber.make(number),
  code: StockCode.make("BBCA"),
  second: "10:23:18",
  side,
})
const tiedDetail = (
  buy: number,
  sell: number,
  buyerType = HOPE_TRADES[1]!.codes.buyerType
) => ({
  ...HOPE_DETAILS[0]!,
  time: "10:23:18",
  code: "BBCA",
  buyer: {
    ...HOPE_DETAILS[0]!.buyer,
    type: buyerType,
    order_id: `20261120${String(buy).padStart(10, "0")}`,
    broker_code: HOPE_TRADES[1]!.codes.buyer,
  },
  seller: {
    ...HOPE_DETAILS[0]!.seller,
    type: HOPE_TRADES[1]!.codes.sellerType,
    order_id: `20261120${String(sell).padStart(10, "0")}`,
    broker_code: HOPE_TRADES[1]!.codes.seller,
  },
  board: HOPE_TRADES[1]!.board,
  price: HOPE_TRADES[1]!.price,
  qty: HOPE_TRADES[1]!.lots,
})
// The order numbers the walk posts for kept `trades` from BBCA's `rows`, by
// trade number. The tape walk read every other trade of the day but those
// numbered in `unread`.
const tiedOrders = Effect.fnUntraced(function* (
  trades: ReadonlyArray<TapeTrade>,
  rows: ReadonlyArray<unknown>,
  unread: ReadonlyArray<number> = []
) {
  yield* evening
  const { store } = yield* keptStore(trades, unread)
  const production = fakeProduction()
  const walk = yield* walkWith(
    fakeAjaib({ details: { BBCA: rows } }),
    store,
    production
  )
  yield* walk.walk(DAY)
  return production.orders()
})

describe("the Done Details walk", () => {
  it.effect(
    "gives 1,230 of HOPE's 1,312 trades Ajaib's order numbers, each as Stockbit reads it",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore()
        const production = fakeProduction()
        const tab = fakeAjaib()
        const walk = yield* walkWith(tab, store, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        const orders = production.orders()
        assert.strictEqual(orders.size, 1_230)
        for (const [number, posted] of orders)
          assert.deepStrictEqual(posted, STOCKBIT.get(number)?.orders)
        // The one RG trade Ajaib's route doesn't list, and 81 trades tied on
        // their second, board, price, lots, codes and side with another that
        // a trade of HOPE falls between.
        const tieOf = (trade: KeptTrade) =>
          JSON.stringify([
            trade.second,
            trade.board,
            trade.price,
            trade.lots,
            trade.codes,
            trade.side,
          ])
        const ties = new Map<string, number>()
        for (const trade of HOPE_TRADES)
          ties.set(tieOf(trade), (ties.get(tieOf(trade)) ?? 0) + 1)
        const unmatched = HOPE_TRADES.filter(
          (trade) => !orders.has(trade.number)
        )
        assert.deepStrictEqual(
          unmatched
            .filter((trade) => ties.get(tieOf(trade)) === 1)
            .map((trade) => trade.second),
          ["09:47:59"]
        )
        assert.lengthOf(unmatched, 82)
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

  it.effect(
    "gives tied trades on opposite sides the orders whose larger number is their aggressor's, whatever Ajaib's order",
    () =>
      Effect.gen(function* () {
        // The sell's row first: buy order 102 hit by sell order 105.
        const orders = yield* tiedOrders(
          [tied("1", "buy"), tied("2", "sell")],
          [tiedDetail(102, 105), tiedDetail(100, 90)]
        )
        assert.deepStrictEqual(orders.get("1"), orderPair(100, 90))
        assert.deepStrictEqual(orders.get("2"), orderPair(102, 105))
      })
  )

  it.effect(
    "gives one side's tied trades with no other trade of the code between them its rows in order of their aggressor orders",
    () =>
      Effect.gen(function* () {
        const orders = yield* tiedOrders(
          [tied("1", "buy"), tied("2", "buy")],
          [tiedDetail(102, 50), tiedDetail(100, 50)]
        )
        assert.deepStrictEqual(orders.get("1"), orderPair(100, 50))
        assert.deepStrictEqual(orders.get("2"), orderPair(102, 50))
      })
  )

  // A foreign buyer's order 200 trades first, then a domestic buyer's order
  // 100, from the same broker and seller and the same passive order.
  it.effect(
    "pairs a trade only with a row whose investor types are its own",
    () =>
      Effect.gen(function* () {
        const foreign = tied("1", "buy")
        const domestic = tied("2", "buy")
        const orders = yield* tiedOrders(
          [
            { ...foreign, codes: { ...foreign.codes, buyerType: "F" } },
            { ...domestic, codes: { ...domestic.codes, buyerType: "D" } },
          ],
          [tiedDetail(200, 50, "F"), tiedDetail(100, 50, "D")]
        )
        assert.deepStrictEqual(orders.get("1"), orderPair(200, 50))
        assert.deepStrictEqual(orders.get("2"), orderPair(100, 50))
      })
  )

  // Ajaib lists three trades alike, the tape walk kept two, and one row's
  // buy order is another day's: the two rows left needn't be the kept two.
  it.effect(
    "gives a code nothing when a row of it can't be read, since it could be any trade's",
    () =>
      Effect.gen(function* () {
        const unread = tiedDetail(100, 50)
        const orders = yield* tiedOrders(
          [tied("1", "buy"), tied("2", "buy")],
          [
            {
              ...unread,
              buyer: { ...unread.buyer, order_id: "202611190000000100" },
            },
            tiedDetail(101, 50),
            tiedDetail(102, 50),
          ]
        )
        assert.strictEqual(orders.size, 0)
      })
  )

  // Trades 1 and 2 are one whole sweep, 4 another: their rows can't be told
  // apart by key, so none of them is given one.
  it.effect(
    "leaves one side's tied trades unmatched when another trade of the code falls between them",
    () =>
      Effect.gen(function* () {
        const orders = yield* tiedOrders(
          [
            tied("1", "buy"),
            tied("2", "buy"),
            tied("3", "sell"),
            tied("4", "buy"),
          ],
          [
            tiedDetail(900, 50),
            tiedDetail(101, 905),
            tiedDetail(102, 50),
            tiedDetail(100, 50),
          ]
        )
        assert.deepStrictEqual([...orders.keys()], ["3"])
        assert.deepStrictEqual(orders.get("3"), orderPair(101, 905))
      })
  )

  // Trade 2, a sell between buys 1 and 3, came without valid fields, so
  // the tape walk kept it unkeyed: 1 and 3 may be two whole sweeps.
  it.effect(
    "leaves tied trades unmatched when a trade of the code the tape walk read without its fields falls between them",
    () =>
      Effect.gen(function* () {
        const orders = yield* tiedOrders(
          [
            tied("1", "buy"),
            {
              _tag: "Unkeyed",
              number: TradeNumber.make("2"),
              code: StockCode.make("BBCA"),
            },
            tied("3", "buy"),
          ],
          [tiedDetail(900, 50), tiedDetail(101, 905), tiedDetail(100, 50)]
        )
        assert.strictEqual(orders.size, 0)
      })
  )

  // Trade 2's row on the tape had no stock code: it may be BBCA's.
  it.effect(
    "leaves tied trades unmatched when a trade the tape walk couldn't read falls between them",
    () =>
      Effect.gen(function* () {
        const orders = yield* tiedOrders(
          [tied("1", "buy"), tied("3", "buy")],
          [tiedDetail(900, 50), tiedDetail(101, 905), tiedDetail(100, 50)],
          [2]
        )
        assert.strictEqual(orders.size, 0)
      })
  )

  it.effect(
    "still gives tied trades their rows when the trade the tape walk couldn't read lies after them",
    () =>
      Effect.gen(function* () {
        const orders = yield* tiedOrders(
          [tied("1", "buy"), tied("2", "buy")],
          [tiedDetail(101, 905), tiedDetail(102, 50), tiedDetail(100, 50)],
          [3]
        )
        assert.deepStrictEqual(orders.get("1"), orderPair(100, 50))
        assert.deepStrictEqual(orders.get("2"), orderPair(102, 50))
      })
  )

  it.effect(
    "posts every code's matched trades after the last code, in trade order, so each batch touches a narrow run of minutes",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore(MARKET_TRADES)
        const production = fakeProduction()
        const walk = yield* walkWith(
          fakeAjaib({ details: marketDetails() }),
          store,
          production
        )
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.strictEqual(production.orders().size, MARKET_TRADES.length)
        // The dashboard recomputes each minute a batch's trades fall in
        // (sweep-brokers.ts, `recompute`), reading the whole market's
        // minute: batches in trade order touch each minute about once.
        const minuteOf = new Map(
          MARKET_TRADES.map((trade) => [trade.number, trade.second.slice(0, 5)])
        )
        const touched = production.batches.map(
          (batch) =>
            new Set(batch.rows.map(([number]) => minuteOf.get(number))).size
        )
        const minutes = new Set(minuteOf.values()).size
        const recomputed = touched.reduce((sum, each) => sum + each, 0)
        assert.strictEqual(minutes, 410)
        assert.deepStrictEqual(
          production.batches.map((batch) => batch.rows.length),
          [5_000, 5_000, 5_000, 5_000]
        )
        assert.isAtMost(recomputed, minutes + production.batches.length - 1)
        const numbers = production.batches.flatMap((batch) =>
          batch.rows.map(([number]) => Number(number))
        )
        assert.deepStrictEqual(
          numbers,
          [...numbers].sort((a, b) => a - b)
        )
      })
  )

  it.effect(
    "once its matched trades are posted, sends them again on request, in trade order, and walks the day no more",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore(MARKET_TRADES)
        const production = fakeProduction()
        const tab = fakeAjaib({ details: marketDetails() })
        const walk = yield* walkWith(tab, store, production)
        // Nothing to send before the walk has posted the day.
        const early = fakeProduction()
        assert.deepStrictEqual(yield* walk.resend(DAY, early.post), {
          _tag: "walked",
        })
        assert.deepStrictEqual(early.batches, [])
        yield* walk.walk(DAY)
        const asked = tab.paths.length
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.strictEqual(tab.paths.length, asked)
        const extra = fakeProduction()
        assert.deepStrictEqual(yield* walk.resend(DAY, extra.post), {
          _tag: "walked",
        })
        assert.deepStrictEqual(extra.batches, production.batches)
        const other = fakeProduction()
        yield* walk.resend(WibDate.make("2026-11-19"), other.post)
        assert.deepStrictEqual(other.batches, [])
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
      assert.strictEqual(orders.size, 1_229)
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
          Option.some({
            _tag: "Walking",
            code: StockCode.make("HOPE"),
            page: 2,
          })
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
        assert.strictEqual(production.orders().size, 1_230)
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
      assert.strictEqual(production.orders().size, 1_230)
      assert.isAtLeast(yield* Clock.currentTimeMillis, wib("17:30:10"))
    })
  )
})

// A JWT naming `sub` that expires the day after the walk.
const jwt = (sub: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub, exp: Date.parse("2026-11-21T17:30:00+07:00") / 1000 })).replaceAll("=", "")}.c2lnbmF0dXJl`

describe("the Done Details walk's walk token", () => {
  it.effect(
    "signs each call with the cookie's token read at that call, a new one on the very next call",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore()
        const first = jwt("first")
        const second = jwt("second")
        let cookie = first
        const tab = fakeAjaib({
          cookie: () => cookie,
          answer: () => {
            cookie = second
            return undefined
          },
        })
        const walk = yield* walkWith(tab, store, fakeProduction())
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(tab.bearers, [first, second])
      })
  )

  it.effect("with no token in the cookie, signs with the page's own", () =>
    Effect.gen(function* () {
      yield* evening
      const { store } = yield* keptStore()
      const tab = fakeAjaib({ cookie: () => "" })
      const walk = yield* walkWith(tab, store, fakeProduction())
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.deepStrictEqual(tab.bearers, ["token", "token"])
    })
  )

  it.effect("never sends again a token Ajaib answered with a 401", () =>
    Effect.gen(function* () {
      yield* evening
      const { store } = yield* keptStore()
      const production = fakeProduction()
      const cookie = jwt("cookie")
      const tab = fakeAjaib({
        cookie: () => cookie,
        answer: (_, bearer) =>
          bearer === cookie
            ? Option.some({ ...OK(""), status: 401 })
            : undefined,
      })
      const walk = yield* walkWith(tab, store, production)
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.deepStrictEqual(tab.bearers, [cookie, "token", "token"])
      assert.strictEqual(production.orders().size, 1_230)
    })
  )

  it.effect(
    "refuses a token whose calls got no answer twice in a row, not once",
    () =>
      Effect.gen(function* () {
        yield* evening
        const { store } = yield* keptStore()
        const production = fakeProduction()
        const cookie = jwt("cookie")
        // The first page gets no answer once; the second, every time.
        const tab = fakeAjaib({
          cookie: () => cookie,
          answer: (call, bearer) =>
            call === 1 || (call >= 3 && bearer === cookie)
              ? Option.none()
              : undefined,
        })
        const walk = yield* walkWith(tab, store, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(tab.bearers, [
          cookie,
          cookie,
          cookie,
          cookie,
          "token",
        ])
        assert.strictEqual(production.orders().size, 1_230)
      })
  )
})
