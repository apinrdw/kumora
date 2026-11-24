// Seam (a) of spec apinrdw/kumora#138, for the candle book's bound: a full
// day's trades go through the book with a flush each minute, and the test
// reads how many candles the book keeps and what it serves. The sweep alerts
// (spec apinrdw/kumora#510) are read the same way where a flush, a minute
// boundary or a restart sits between a sweep and its decision.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type Candle,
  type RunningTrade,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeCandleBook } from "@/server/market-live/candles"
import { makeDayStore } from "@/server/market-live/day-store"
import { noCells } from "@/server/market-live/footprint-cells"

import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)

const codes = Array.from({ length: FULL_DAY_CODES }, (_, index) =>
  StockCode.make(`C${String(index).padStart(3, "0")}`)
)

const tradeOf = (
  code: StockCode,
  number: number,
  time: DateTime.Utc,
  lots: number,
  side: RunningTrade["side"] = "buy"
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time,
  code,
  price: 100,
  lots,
  side,
  board: "RG",
  feeds: ["Ajaib"],
})

// A flush at `at`, in epoch ms: every trade whose merge window closed by
// then is written.
const flushAt = Effect.fnUntraced(function* (
  book: Effect.Success<ReturnType<typeof makeCandleBook>>,
  store: Effect.Success<ReturnType<typeof makeDayStore>>,
  at: number
) {
  yield* TestClock.setTime(at)
  const settled = yield* book.takeSettled(false)
  yield* store.write({
    ...settled,
    livePrices: [],
    chunks: [],
    ajaibBooks: [],
    facts: {},
  })
  yield* book.written
})

// A flush as the trading day does it, 5 s past the minute.
const flush = (
  book: Effect.Success<ReturnType<typeof makeCandleBook>>,
  store: Effect.Success<ReturnType<typeof makeDayStore>>,
  minute: DateTime.Utc
) => flushAt(book, store, DateTime.toEpochMillis(minute) + 65_000)

describe("the candle book over a full day", () => {
  it.effect(
    "holds no more than the minute being traded, serves every candle, and adds a late trade to a stored one",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql())
        const book = yield* makeCandleBook(store, () => {})
        const first = wib("08:58:00")
        let number = 0
        let most = 0
        // Every code trades once a minute; a delta takes the changes, and a
        // flush writes the minute, as the trading day does.
        for (let index = 0; index < FULL_DAY_MINUTES; index++) {
          const minute = DateTime.add(first, { minutes: index })
          yield* TestClock.setTime(DateTime.toEpochMillis(minute) + 10_000)
          for (const code of codes)
            yield* book.trade(
              undefined,
              tradeOf(code, ++number, DateTime.add(minute, { seconds: 10 }), 1)
            )
          yield* book.takeChanged(new Set())
          most = Math.max(most, yield* book.retained)
          yield* flush(book, store, minute)
        }
        // The open minute's candles, one per code.
        assert.isAtMost(most, FULL_DAY_CODES)
        assert.strictEqual(yield* book.retained, 0)
        const candles = yield* book.candlesOf(codes[0]!)
        assert.lengthOf(candles, FULL_DAY_MINUTES)
        assert.strictEqual(
          DateTime.formatIso(candles[0]!.minute),
          DateTime.formatIso(first)
        )
        assert.deepStrictEqual(
          candles.map((candle) => candle.frequency),
          Array.from({ length: FULL_DAY_MINUTES }, () => 1)
        )
        const later = yield* book.foldAfter(
          codes.at(-1)!,
          DateTime.toEpochMillis(first)
        )
        assert.strictEqual(later?.frequency, FULL_DAY_MINUTES - 1)
        assert.strictEqual(
          later?.closeTime,
          DateTime.toEpochMillis(wib("16:15:10"))
        )

        const late = tradeOf(
          codes[0]!,
          number + 1,
          DateTime.add(first, { seconds: 40 }),
          3
        )
        yield* book.trade(undefined, late)
        const {
          candles: [changed],
        } = yield* book.takeChanged(new Set())
        assert.deepStrictEqual(
          { volume: changed?.volume, frequency: changed?.frequency },
          { volume: 4, frequency: 2 }
        )
        yield* TestClock.adjust("6 seconds")
        const settled = yield* book.takeSettled(false)
        yield* store.write({
          ...settled,
          livePrices: [],
          chunks: [],
          ajaibBooks: [],
          facts: {},
        })
        yield* book.written
        assert.strictEqual(yield* book.retained, 0)
        const [stored] = yield* store.storedCandlesOf(codes[0]!)
        assert.deepStrictEqual(
          {
            volume: stored?.figures.volume,
            frequency: stored?.figures.frequency,
          },
          { volume: 4, frequency: 2 }
        )
        assert.strictEqual((yield* book.candlesOf(codes[0]!))[0]?.volume, 4)
      }),
    { timeout: 120_000 }
  )
})

describe("a candle's buy value and sell value", () => {
  it.effect(
    "sum the minute's trades by aggressor side, with no-side trades in value only; an index's are 0",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql())
        const book = yield* makeCandleBook(store, () => {})
        const minute = wib("09:00:00")
        yield* TestClock.setTime(DateTime.toEpochMillis(minute) + 10_000)
        const code = StockCode.make("BBCA")
        const at = (seconds: number) => DateTime.add(minute, { seconds })
        yield* book.trade(undefined, {
          ...tradeOf(code, 1, at(1), 2),
          side: "buy",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 2, at(2), 3),
          price: 110,
          side: "sell",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 3, at(3), 1),
          price: 105,
          side: "none",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 4, at(4), 4),
          side: "buy",
        })
        yield* book.indexPrice({
          code: StockCode.make("COMPOSITE"),
          time: at(5),
          last: 7_000,
          volume: 1_000,
          value: 5_000_000,
          frequency: 10,
          previous: undefined,
          isIndex: true,
          high: undefined,
          low: undefined,
          open: undefined,
          change: undefined,
          changePercent: undefined,
          regularBoard: true,
        })
        const split = (candle: Candle | undefined) => ({
          value: candle?.value,
          buyValue: candle?.buyValue,
          sellValue: candle?.sellValue,
        })
        // 2 and 4 lots bought at 100, 3 sold at 110, 1 matched at 105.
        const expected = {
          value: 103_500,
          buyValue: 60_000,
          sellValue: 33_000,
        }
        const { candles } = yield* book.takeChanged(new Set())
        assert.deepStrictEqual(
          split(candles.find((candle) => candle.code === code)),
          expected
        )
        assert.deepStrictEqual(
          split(candles.find((candle) => candle.code === "COMPOSITE")),
          { value: 0, buyValue: 0, sellValue: 0 }
        )
        yield* flush(book, store, minute)
        assert.deepStrictEqual(
          split((yield* book.candlesOf(code))[0]),
          expected
        )
      })
  )
})

describe("the candle book's sweep alerts", () => {
  const UNTR = StockCode.make("UNTR")
  const BBCA = StockCode.make("BBCA")
  const at = (time: string) => DateTime.toEpochMillis(wib(time))

  // `count` one-lot UNTR buy sweeps, one a second from 09:00:00 WIB, numbered
  // from 1: its buy side's warm-up when 100.
  const warm = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      tradeOf(
        UNTR,
        index + 1,
        DateTime.add(wib("09:00:00"), { seconds: index }),
        1
      )
    )

  // A day store, and a book over it: opening a second one is a restart.
  // `alerts` hears `trades` at `time` and gives the next delta's alerts.
  const day = Effect.gen(function* () {
    const store = yield* makeDayStore(memorySql())
    const open = Effect.gen(function* () {
      const book = yield* makeCandleBook(store, () => {})
      const alerts = Effect.fnUntraced(function* (
        time: string,
        trades: ReadonlyArray<RunningTrade>
      ) {
        yield* TestClock.setTime(at(time))
        for (const trade of trades) yield* book.trade(undefined, trade)
        return (yield* book.takeChanged(new Set())).sweepAlerts.map((alert) => [
          alert.code,
          alert.side,
          alert.lots,
          alert.tradeNumbers,
        ])
      })
      return { book, alerts }
    })
    return { store, open }
  })

  it.effect(
    "a sweep still waiting for its second to close when a flush lets its minute go is decided once, against the sweeps before it",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const { book, alerts } = yield* open
        // 99 buy sweeps, then the 100th: its second, the latest, is open.
        assert.deepStrictEqual(
          yield* alerts("09:01:40.500", [
            ...warm(99),
            tradeOf(UNTR, 100, wib("09:01:40"), 100),
          ]),
          []
        )
        // The feed pauses past the merge window, and the flush stores the
        // minute: the book lets it go.
        yield* flushAt(book, store, at("09:01:46"))
        assert.strictEqual(yield* book.retained, 0)
        // A trade reopens the minute and closes the 100th sweep's second: it
        // had 99 before it, and stays silent.
        assert.deepStrictEqual(
          yield* alerts("09:01:47", [
            tradeOf(UNTR, 101, wib("09:01:46"), 1, "sell"),
          ]),
          []
        )
        // It ranked once. 100 sweeps cut at the largest, 100 lots, so 50
        // lots are silent; 101 cut at the 2nd largest, those 50, so 60
        // alert. Ranked twice, the 2nd largest would be 100.
        assert.deepStrictEqual(
          yield* alerts("09:01:49.500", [
            tradeOf(UNTR, 102, wib("09:01:47"), 50),
            tradeOf(UNTR, 103, wib("09:01:48"), 60),
            tradeOf(BBCA, 104, wib("09:01:49"), 1),
          ]),
          [[UNTR, "buy", 60, [TradeNumber.make("103")]]]
        )
      })
  )

  it.effect(
    "an alert decided after the book let its minute go still names the sweep's trades",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const { book, alerts } = yield* open
        assert.deepStrictEqual(
          yield* alerts("09:01:45.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 15),
            tradeOf(UNTR, 102, wib("09:01:45"), 15),
          ]),
          []
        )
        yield* flushAt(book, store, at("09:01:51"))
        assert.strictEqual(yield* book.retained, 0)
        // Another code's trade closes the sweep's second.
        assert.deepStrictEqual(
          yield* alerts("09:01:52", [tradeOf(BBCA, 103, wib("09:01:51"), 1)]),
          [
            [
              UNTR,
              "buy",
              30,
              [TradeNumber.make("101"), TradeNumber.make("102")],
            ],
          ]
        )
      })
  )

  it.effect(
    "a sweep waiting in the minute before is decided ahead of the next minute's, in trade order",
    () =>
      Effect.gen(function* () {
        const { alerts } = yield* (yield* day).open
        // The 100th buy sweep waits in 09:01's last second.
        assert.deepStrictEqual(
          yield* alerts("09:01:59.500", [
            ...warm(99),
            tradeOf(UNTR, 100, wib("09:01:59"), 1),
          ]),
          []
        )
        // One batch closes that second and the next minute's first: the big
        // sweep there has 100 before it.
        assert.deepStrictEqual(
          yield* alerts("09:02:01.500", [
            tradeOf(UNTR, 101, wib("09:02:00"), 500),
            tradeOf(UNTR, 102, wib("09:02:01"), 1, "sell"),
          ]),
          [[UNTR, "buy", 500, [TradeNumber.make("101")]]]
        )
      })
  )

  it.effect(
    "after a restart, a stored sweep timed after the newest trade heard since neither leaves the ranking nor alerts again",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const before = yield* open
        assert.deepStrictEqual(
          yield* before.alerts("09:01:46.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 500),
            tradeOf(BBCA, 102, wib("09:01:46"), 1),
          ]),
          [[UNTR, "buy", 500, [TradeNumber.make("101")]]]
        )
        yield* flushAt(before.book, store, at("09:01:52"))

        const { book, alerts } = yield* open
        yield* book.rankStored
        // A lagging feed's trade reopens the minute, timed before the stored
        // big sweep's second.
        assert.deepStrictEqual(
          yield* alerts("09:01:53", [
            tradeOf(UNTR, 103, wib("09:01:42"), 1, "sell"),
          ]),
          []
        )
        // A later trade closes that second: the big sweep was decided before
        // the restart.
        assert.deepStrictEqual(
          yield* alerts("09:01:54", [tradeOf(BBCA, 104, wib("09:01:50"), 1)]),
          []
        )
        // It ranks once: 101 buy sweeps cut at the 2nd largest, one lot.
        // Ranked twice, they would cut at 500.
        assert.deepStrictEqual(
          yield* alerts("09:01:56.500", [
            tradeOf(UNTR, 105, wib("09:01:55"), 400),
            tradeOf(BBCA, 106, wib("09:01:56"), 1),
          ]),
          [[UNTR, "buy", 400, [TradeNumber.make("105")]]]
        )
      })
  )

  it.effect(
    "late trades numbered after a decided sweep, in its second, make a new sweep that is decided",
    () =>
      Effect.gen(function* () {
        const { alerts } = yield* (yield* day).open
        // The 101st buy sweep, its minute's last, alerts.
        assert.deepStrictEqual(
          yield* alerts("09:01:46.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 500),
            tradeOf(BBCA, 102, wib("09:01:46"), 1),
          ]),
          [[UNTR, "buy", 500, [TradeNumber.make("101")]]]
        )
        // A lagging feed's sell and buy land in that second, numbered after
        // it: the buy holds none of the decided sweep's trades.
        assert.deepStrictEqual(
          yield* alerts("09:01:47", [
            tradeOf(UNTR, 103, wib("09:01:45"), 1, "sell"),
            tradeOf(UNTR, 104, wib("09:01:45"), 400),
          ]),
          [[UNTR, "buy", 400, [TradeNumber.make("104")]]]
        )
      })
  )

  it.effect(
    "late trades numbered inside a stored, decided sweep split it, and only the new sweep between its halves is decided",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const { book, alerts } = yield* open
        // Trades 101 and 105 make the 101st buy sweep, and it alerts.
        assert.deepStrictEqual(
          yield* alerts("09:01:46.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 200),
            tradeOf(UNTR, 105, wib("09:01:45"), 600),
            tradeOf(BBCA, 106, wib("09:01:46"), 1),
          ]),
          [
            [
              UNTR,
              "buy",
              800,
              [TradeNumber.make("101"), TradeNumber.make("105")],
            ],
          ]
        )
        yield* flushAt(book, store, at("09:01:52"))
        assert.strictEqual(yield* book.retained, 0)
        // A lagging feed's sell, buy and sell land between the two. The
        // second half, 600 lots, is above the cutoff and stays silent.
        assert.deepStrictEqual(
          yield* alerts("09:01:53", [
            tradeOf(UNTR, 102, wib("09:01:45"), 1, "sell"),
            tradeOf(UNTR, 103, wib("09:01:45"), 400),
            tradeOf(UNTR, 104, wib("09:01:45"), 1, "sell"),
          ]),
          [[UNTR, "buy", 400, [TradeNumber.make("103")]]]
        )
        // The halves rank as 200 and 600 beside the 400: 103 buy sweeps cut
        // at the 2nd largest, 400, so 350 lots are silent and 400 alert.
        assert.deepStrictEqual(
          yield* alerts("09:01:56.500", [
            tradeOf(UNTR, 107, wib("09:01:54"), 350),
            tradeOf(UNTR, 108, wib("09:01:55"), 400),
            tradeOf(BBCA, 109, wib("09:01:56"), 1),
          ]),
          [[UNTR, "buy", 400, [TradeNumber.make("108")]]]
        )
      })
  )

  // A seeded generator of numbers in [0, 1): mulberry32.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }

  // Both sides' rankings of each code, as a book's rule holds them.
  const rankings = Effect.fnUntraced(function* (
    book: Effect.Success<ReturnType<typeof makeCandleBook>>
  ) {
    const all: Array<unknown> = []
    for (const code of [UNTR, BBCA])
      for (const side of ["buy", "sell"] as const)
        all.push([code, side, yield* book.sweepRanking(code, side)])
    return all
  })

  // One-lot sweeps a side that each code's day starts from, stored at 08:00
  // WIB: a side so warm cuts at one lot while it holds fewer than a
  // hundredth as many bigger sweeps, so every sweep decided alerts.
  const WARM = 7_000
  const storeWarm = Effect.fnUntraced(function* (
    store: Effect.Success<ReturnType<typeof makeDayStore>>
  ) {
    const time = wib("08:00:00")
    const cells = yield* noCells
    yield* store.write({
      trades: [],
      candles: [],
      footprints: [UNTR, BBCA].map((code) => ({
        code,
        minute: DateTime.toEpochMillis(time),
        cells,
        sweeps: Array.from({ length: WARM * 2 }, (_, index) => ({
          side: index % 2 === 0 ? ("buy" as const) : ("sell" as const),
          firstTrade: TradeNumber.make(String(1_000_000 + index)),
          time,
          first: 100,
          last: 100,
          lots: 1,
          value: 10_000,
          trades: 1,
        })),
        lastTrade: BigInt(1_000_000 + WARM * 2),
      })),
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {},
    })
  })

  // A sweep alert as the tests compare them.
  type Alerted = readonly [
    code: StockCode,
    side: RunningTrade["side"],
    lots: number,
    tradeNumbers: ReadonlyArray<TradeNumber>,
  ]
  const inTradeOrder = (alerts: ReadonlyArray<Alerted>) =>
    [...alerts].sort((a, b) => Number(a[3][0]) - Number(b[3][0]))

  // The alert rule's decisions, worked out apart from its code: each trade
  // as last heard and, once a sweep holding it ranked, the side and second
  // it ranked under. A sweep with a trade ranked under its own side and
  // second regroups a ranked sweep, and any other is new: decided once, at
  // the first delta after its second closed. Every side cuts at one lot
  // (`storeWarm`), so a decided sweep alerts unless its second closed more
  // than 10 s before (sweep-alerts.ts, `MAX_AGE`).
  const reference = () => {
    const heard = new Map<TradeNumber, RunningTrade>()
    const rankedAs = new Map<TradeNumber, string>()
    // Every trade a code's side ever held: more than its bigger sweeps.
    const sided = new Map<string, Set<TradeNumber>>()
    let latest = -Infinity
    const secondOf = (trade: RunningTrade) =>
      Math.floor(DateTime.toEpochMillis(trade.time) / 1000)
    // The trades as sweeps: a code's in one minute, by number, together
    // while they share a side and a second.
    const sweeps = () => {
      const minutes = new Map<string, Array<RunningTrade>>()
      for (const trade of heard.values()) {
        const key = `${trade.code} ${Math.floor(secondOf(trade) / 60)}`
        const minute = minutes.get(key)
        if (minute === undefined) minutes.set(key, [trade])
        else minute.push(trade)
      }
      return [...minutes.values()].flatMap((trades) => {
        const grouped: Array<Array<RunningTrade>> = []
        for (const trade of trades.sort(
          (a, b) => Number(a.tradeNumber) - Number(b.tradeNumber)
        )) {
          const last = grouped.at(-1)
          if (
            last !== undefined &&
            last[0]!.side === trade.side &&
            secondOf(last[0]!) === secondOf(trade)
          )
            last.push(trade)
          else grouped.push([trade])
        }
        return grouped
      })
    }
    const keyOf = (sweep: ReadonlyArray<RunningTrade>) =>
      `${sweep[0]!.side} ${secondOf(sweep[0]!)}`
    return {
      hear: (trade: RunningTrade) => {
        heard.set(trade.tradeNumber, trade)
        latest = Math.max(latest, DateTime.toEpochMillis(trade.time))
        const side = `${trade.code} ${trade.side}`
        sided.set(side, (sided.get(side) ?? new Set()).add(trade.tradeNumber))
      },
      // A restart ranks every stored sweep without a decision, and has
      // heard no trade yet.
      restart: () => {
        for (const sweep of sweeps())
          if (sweep[0]!.side !== "none")
            for (const trade of sweep)
              rankedAs.set(trade.tradeNumber, keyOf(sweep))
        latest = -Infinity
      },
      // The alerts of a delta at `now`, in epoch ms.
      decide: (now: number) => {
        const closedBefore = Math.floor(latest / 1000)
        const alerts: Array<Alerted> = []
        for (const sweep of sweeps()) {
          const [first] = sweep
          const second = secondOf(first!)
          const key = keyOf(sweep)
          const regroups = sweep.some(
            (trade) => rankedAs.get(trade.tradeNumber) === key
          )
          const decided =
            first!.side !== "none" && !regroups && second < closedBefore
          if (decided && now - (second + 1) * 1000 <= 10_000)
            alerts.push([
              first!.code,
              first!.side,
              sweep.reduce((lots, trade) => lots + trade.lots, 0),
              sweep.map((trade) => trade.tradeNumber),
            ])
          for (const { tradeNumber } of sweep)
            if (regroups || decided) rankedAs.set(tradeNumber, key)
            else rankedAs.delete(tradeNumber)
        }
        return alerts
      },
      busiest: () => Math.max(...[...sided.values()].map((side) => side.size)),
    }
  }

  const TRADES = 160
  // A trade every 250 ms: four a second over two codes.
  const STEP = 250
  // How long the market goes quiet: past the merge window, so a flush then
  // stores every trade and lets every candle go.
  const QUIET = 6000

  // A random day from 09:00 WIB: its trades in the order they arrive, each
  // with its place among them, the quiet spells up to a place, and a place's
  // time.
  const randomDay = (next: () => number) => {
    const start = at("09:00:00")
    const pick = (below: number) => Math.floor(next() * below)
    // The market goes quiet before one trade in 25.
    let spells = 0
    const quiets = Array.from({ length: TRADES }, () => {
      if (next() < 0.04) spells += 1
      return spells
    })
    const quietsAt = (place: number) =>
      quiets[Math.min(Math.floor(place), TRADES - 1)]!
    const timeAt = (place: number) =>
      start + quietsAt(place) * QUIET + place * STEP
    // Trades numbered in time order, each timed to its second. One in seven
    // arrives late, by up to 40 places, and now and then a lagging feed
    // hands over a run of up to five together, late.
    const trades = Array.from({ length: TRADES }, (_, index) =>
      tradeOf(
        next() < 0.5 ? UNTR : BBCA,
        index + 1,
        DateTime.makeUnsafe(Math.floor(timeAt(index) / 1000) * 1000),
        1 + pick(20),
        (["buy", "sell", "buy", "sell", "none"] as const)[pick(5)]
      )
    )
    let run = { left: 0, place: 0 }
    const arrivals = trades
      .map((trade, index) => {
        if (run.left === 0 && next() < 0.04)
          run = { left: 2 + pick(4), place: index + 8 + next() * 24 }
        if (run.left === 0)
          return { trade, place: index + (next() < 0.15 ? next() * 40 : 0) }
        run.left -= 1
        return { trade, place: run.place }
      })
      .sort((a, b) => a.place - b.place)
    return { start, arrivals, quietsAt, timeAt }
  }

  it.effect(
    "whatever the order of trades, re-sided copies, quiet spells, flushes and restarts, each new sweep is decided once and the ranking ends as a restart would rebuild it from the store",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 60; seed++) {
          const next = random(seed)
          const pick = (below: number) => Math.floor(next() * below)
          const store = yield* makeDayStore(memorySql())
          yield* storeWarm(store)
          let book = yield* makeCandleBook(store, () => {})
          yield* book.rankStored
          const model = reference()
          // A delta: its alerts are the reference's, in trade order.
          const delta = Effect.gen(function* () {
            const { sweepAlerts } = yield* book.takeChanged(new Set())
            assert.deepStrictEqual(
              inTradeOrder(
                sweepAlerts.map((alert): Alerted => [
                  alert.code,
                  alert.side,
                  alert.lots,
                  alert.tradeNumbers,
                ])
              ),
              inTradeOrder(model.decide(yield* Clock.currentTimeMillis)),
              `seed ${seed}`
            )
          })
          const { start, arrivals, quietsAt, timeAt } = randomDay(next)
          let now = start
          // The trades that first arrived in the last 2 s, each as the book
          // holds it: all well inside their merge windows.
          let open: Array<{
            readonly trade: RunningTrade
            readonly arrived: number
          }> = []
          const hear = Effect.fnUntraced(function* (
            held: RunningTrade | undefined,
            trade: RunningTrade
          ) {
            yield* book.trade(held, trade)
            model.hear(trade)
            const arrived =
              open.find((other) => other.trade === held)?.arrived ?? now
            open = [
              ...open.filter((other) => other.trade !== held),
              { trade, arrived },
            ].filter((other) => now - other.arrived < 2000)
          })
          // A second feed's copy gives a trade another side.
          const copy = (trade: RunningTrade) =>
            hear(trade, {
              ...trade,
              side: trade.side === "buy" ? "sell" : "buy",
            })
          let spent = 0
          for (const { trade, place } of arrivals) {
            // A quiet spell before this trade: a flush in it lets go of
            // every candle, the newest sweeps still waiting. After one in
            // four the object restarts, and the new book ranks what is
            // stored.
            for (; spent < quietsAt(place); spent++) {
              yield* delta
              yield* flushAt(book, store, now + QUIET - 500)
              now += QUIET
              open = []
              if (next() < 0.25) {
                book = yield* makeCandleBook(store, () => {})
                yield* book.rankStored
                model.restart()
              }
            }
            now = timeAt(place) + 500
            yield* TestClock.setTime(now)
            yield* hear(undefined, trade)
            if (next() < 0.05) yield* copy(trade)
            if (next() < 0.3) yield* delta
            // A copy of a trade heard a moment ago, which a delta may have
            // decided since.
            if (next() < 0.05) yield* copy(open[pick(open.length)]!.trade)
            if (next() < 0.04) yield* flushAt(book, store, now)
          }
          // A later auction print closes every second, and all is stored.
          yield* hear(
            undefined,
            tradeOf(BBCA, TRADES + 1, wib("09:10:00"), 1, "none")
          )
          yield* delta
          yield* flushAt(book, store, now + 12_000)
          yield* delta
          // Each side cut at one lot all day, as the reference takes it.
          assert.isBelow(model.busiest(), WARM / 100, `seed ${seed}`)
          const rebuilt = yield* makeCandleBook(store, () => {})
          yield* rebuilt.rankStored
          assert.deepStrictEqual(
            yield* rankings(book),
            yield* rankings(rebuilt),
            `seed ${seed}`
          )
        }
      }),
    { timeout: 60_000 }
  )
})
