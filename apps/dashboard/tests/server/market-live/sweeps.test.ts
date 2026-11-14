// Seam (1) of spec apinrdw/kumora#263 for sweeps (ticket apinrdw/kumora#266):
// Stockbit trades go in through the ingest socket, time moves only by
// TestClock, and the test reads the sweeps GET and the minutes of sweeps the
// deltas carry. The page tests join the two through the page's own sweep
// store: whatever reaches the day, the page's sweeps are a fresh GET's.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, decodeViewerDown, type Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeSweepStore } from "@/components/market-live/sweep-store"
import { SEALED_CACHE } from "@/server/market-live/routes"

import { ajaibTrade, stockbitTrade, sweepOf, tradingDay } from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

const untr = (
  number: number,
  time: string,
  price: number,
  lots: number,
  side?: "buy" | "sell"
) =>
  stockbitTrade({
    number,
    time,
    price,
    lots,
    ...(side === undefined ? {} : { side }),
  })

const bbca = (number: number, time: string) =>
  stockbitTrade({
    number,
    time,
    code: "BBCA",
    price: 8000,
    lots: 7,
    side: "sell",
  })

// A sweep whole, its identity and value with what `sweepOf` compares.
const full = (sweep: Sweep) => [
  ...sweepOf(sweep),
  sweep.firstTrade,
  sweep.value,
]

// A Market Live page on `code`: its sweep store hears what the object sends
// its socket, and the sweeps GET answers what the store asks.
const pageOn = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof tradingDay>>,
  code: string
) {
  let socket = yield* day.viewer(code)
  const store = yield* makeSweepStore(StockCode.make(code))
  let heard = 0
  let asks = 0
  // The store reads every message sent since it last heard.
  const hear = Effect.gen(function* () {
    for (const text of socket.sent.slice(heard))
      store.apply(yield* decodeViewerDown(text))
    heard = socket.sent.length
  })
  // The GET answers the store's ask now; the returned call lands the answer.
  const ask = Effect.gen(function* () {
    const asked = store.awaiting()
    assert.isDefined(asked)
    asks += 1
    const { answer } = yield* day.recordedSweeps(code)
    return () => store.answer(asked, answer)
  })
  // Hears and asks until the store has nothing left to ask.
  const settle = Effect.gen(function* () {
    yield* hear
    while (store.awaiting() !== undefined) {
      const land = yield* ask
      land()
      yield* hear
    }
  })
  // The page's socket drops, and it connects again on a new one.
  const drop = Effect.suspend(() => day.left(socket))
  const reconnect = Effect.gen(function* () {
    socket = yield* day.viewer(code)
    heard = 0
  })
  return {
    hear,
    ask,
    settle,
    drop,
    reconnect,
    asks: () => asks,
    sweeps: () => store.sweeps().map(full),
  }
})

// A fresh GET's sweeps, whole: what the page's must be.
const fresh = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof tradingDay>>,
  code: string
) {
  return (yield* day.recordedSweeps(code)).answer.sweeps.map(full)
})

describe("sweeps", () => {
  it.effect(
    "group a code's trades by aggressor side and second: another code never breaks one, the other side or a no-side trade does, other boards don't count",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          bbca(40002, "09:00:10.200"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
          untr(40004, "09:00:10.600", 23300, 1, "sell"),
          untr(40005, "09:00:10.700", 23325, 4, "buy"),
          // No aggressor side: an auction-style print.
          untr(40006, "09:00:10.800", 23325, 5),
          untr(40007, "09:00:10.900", 23325, 6, "buy"),
          // The next second.
          untr(40008, "09:00:11.000", 23325, 1, "buy"),
          stockbitTrade({
            number: 40009,
            time: "09:00:11.200",
            price: 30000,
            lots: 500,
            side: "sell",
            board: "NG",
          }),
          untr(40010, "09:00:11.500", 23350, 2, "buy"),
        ])
        const { cacheControl, answer } = yield* day.recordedSweeps("UNTR")
        assert.strictEqual(cacheControl, "no-store")
        assert.deepStrictEqual(answer.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 5, 2],
          ["sell", "2026-11-09T02:00:10.600Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.700Z", 23325, 23325, 4, 1],
          ["none", "2026-11-09T02:00:10.800Z", 23325, 23325, 5, 1],
          ["buy", "2026-11-09T02:00:10.900Z", 23325, 23325, 6, 1],
          ["buy", "2026-11-09T02:00:11.000Z", 23325, 23350, 3, 2],
        ])
        assert.strictEqual(answer.sweeps[0]!.value, 23300 * 200 + 23325 * 300)
        // Each names its first trade.
        assert.deepStrictEqual(
          answer.sweeps.map((sweep) => sweep.firstTrade),
          ["40001", "40004", "40005", "40006", "40007", "40008"]
        )
      })
  )

  it.effect(
    "a late trade in a minute already stored splits its sweep, served and stored rebuilt",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
          untr(40004, "09:00:30.000", 23325, 3, "sell"),
        ])
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 1, "sell")])
        const rebuilt = [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
          ["sell", "2026-11-09T02:00:30.000Z", 23325, 23325, 3, 1],
        ]
        assert.deepStrictEqual(
          (yield* day.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          rebuilt
        )
        yield* TestClock.adjust("1 minute")
        const restarted = yield* tradingDay(sql)
        assert.deepStrictEqual(
          (yield* restarted.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          rebuilt
        )
      })
  )

  it.effect(
    "a trade numbered after a minute already stored carries its last sweep on, served and stored",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:12")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40002, "09:00:10.500", 23300, 1, "sell"),
          untr(40003, "09:00:10.600", 23325, 3, "buy"),
        ])
        // Past the merge window and the minute's flush, which lets it go.
        yield* TestClock.adjust("2 minutes")
        // A second feed's late copy of the same second, numbered after.
        yield* day.trades([
          untr(40004, "09:00:10.900", 23350, 4, "buy"),
          untr(40005, "09:00:40.000", 23350, 1, "sell"),
        ])
        const carried = [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.500Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.600Z", 23325, 23350, 7, 2],
          ["sell", "2026-11-09T02:00:40.000Z", 23350, 23350, 1, 1],
        ]
        assert.deepStrictEqual(
          (yield* day.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          carried
        )
        yield* TestClock.adjust("1 minute")
        const restarted = yield* tradingDay(sql)
        assert.deepStrictEqual(
          (yield* restarted.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          carried
        )
      })
  )

  it.effect(
    "a delta carries each minute a trade changed of a code a viewer selected, its sweeps whole as the GET answers them, and no other code's",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const viewer = yield* day.viewer("UNTR")
        // The sweeps of the last delta sent, by minute.
        const carried = Effect.gen(function* () {
          const last = (yield* viewer.received).at(-1)
          assert.strictEqual(last?._tag, "Delta")
          return (last?._tag === "Delta" ? (last.sweeps ?? []) : [])
            .map((minute) => [
              minute.code,
              DateTime.formatIso(minute.minute),
              minute.sweeps.map(full),
            ])
            .sort(([, a], [, b]) => String(a).localeCompare(String(b)))
        })
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          bbca(40002, "09:00:10.200"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
          untr(40004, "09:01:02.000", 23300, 4, "sell"),
        ])
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* carried, [
          [
            "UNTR",
            "2026-11-09T02:00:00.000Z",
            [
              [
                "buy",
                "2026-11-09T02:00:10.100Z",
                23300,
                23325,
                5,
                2,
                "40001",
                23300 * 200 + 23325 * 300,
              ],
            ],
          ],
          [
            "UNTR",
            "2026-11-09T02:01:00.000Z",
            [
              [
                "sell",
                "2026-11-09T02:01:02.000Z",
                23300,
                23300,
                4,
                1,
                "40004",
                23300 * 400,
              ],
            ],
          ],
        ])
        // Only the minute that changed, whole again.
        yield* day.trades([untr(40005, "09:01:02.500", 23275, 1, "sell")])
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* carried, [
          [
            "UNTR",
            "2026-11-09T02:01:00.000Z",
            [
              [
                "sell",
                "2026-11-09T02:01:02.000Z",
                23300,
                23275,
                5,
                2,
                "40004",
                23300 * 400 + 23275 * 100,
              ],
            ],
          ],
        ])
      })
  )

  it.effect(
    "a page asks the GET once for a snapshot: the trades that follow its answer, in any order, reach its sweeps by the deltas",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        // Answered before the delta carrying those trades goes out.
        yield* page.settle
        // 40006 arrives before 40005.
        for (const [number, time] of [
          [40004, "09:00:10.900"],
          [40006, "09:00:11.300"],
          [40005, "09:00:11.100"],
        ] as const) {
          yield* TestClock.adjust("250 millis")
          yield* day.trades([untr(number, time, 23325, 1, "buy")])
        }
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.strictEqual(page.asks(), 1)
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 6, 3],
            ["buy", "2026-11-09T02:00:11.100Z", 23325, 23325, 2, 2],
          ]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "a late trade numbered below the page's answer splits its sweep on the page, the GET not asked again",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
            ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 4, 1],
            ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
          ]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
        assert.strictEqual(page.asks(), 1)
      })
  )

  it.effect(
    "a backfilled trade older than a full tape's oldest, which no delta's tape carries, reaches the page's sweeps",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* page.settle
        // A tape of newer trades evicts UNTR's two.
        for (let batch = 0; batch < 10; batch++)
          yield* day.trades(
            Array.from({ length: 1_000 }, (_, i) =>
              bbca(50001 + batch * 1_000 + i, "09:00:20.000")
            )
          )
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        yield* day.trades([untr(45000, "09:00:10.700", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 5, 2],
            ["sell", "2026-11-09T02:00:10.700Z", 23300, 23300, 4, 1],
          ]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      }),
    60_000
  )

  it.effect(
    "a late trade that lands while the page's answer is on its way reaches the page's sweeps, whichever of its delta and the answer arrives first",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const first = yield* pageOn(day, "UNTR")
        const second = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* first.hear
        yield* second.hear
        // Both answered without 40002.
        const landFirst = yield* first.ask
        const landSecond = yield* second.ask
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        // The delta carrying 40002's minute arrives before one answer and
        // after the other.
        yield* first.hear
        landFirst()
        landSecond()
        yield* first.settle
        yield* second.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
            ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 4, 1],
            ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
          ]
        )
        assert.deepStrictEqual(first.sweeps(), whole)
        assert.deepStrictEqual(second.sweeps(), whole)
      })
  )

  it.effect(
    "Stockbit's time moving a trade Ajaib rounded into the next minute, its side unchanged, empties that minute on the page",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:59",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // Ajaib rounds 09:00:59.900 up.
          ajaibTrade({
            number: 40002,
            time: "09:01:00",
            price: 23300,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.deepStrictEqual(
          page.sweeps().map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:59.000Z", 23300, 23300, 2, 1],
            ["buy", "2026-11-09T02:01:00.000Z", 23300, 23300, 3, 1],
          ]
        )
        yield* day.trades([untr(40002, "09:00:59.900", 23300, 3, "buy")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [["buy", "2026-11-09T02:00:59.000Z", 23300, 23300, 5, 2]]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "Stockbit's time moving a trade to another second of its minute regroups the GET's sweeps at once, and the page's",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // Ajaib rounds 09:00:10.600 up.
          ajaibTrade({
            number: 40002,
            time: "09:00:11",
            price: 23300,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.deepStrictEqual(
          page.sweeps().map((sweep) => sweep.slice(0, 6)),
          [
            ["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 2, 1],
            ["buy", "2026-11-09T02:00:11.000Z", 23300, 23300, 3, 1],
          ]
        )
        yield* day.trades([untr(40002, "09:00:10.600", 23300, 3, "buy")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        // Still inside 40002's merge window.
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 5, 2]]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "Stockbit's time moving a sweep's first trade inside its second retimes the sweep on the page as the stored minute has it",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        // Ajaib rounds 09:00:10.400 down.
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        yield* day.trades([untr(40001, "09:00:10.400", 23300, 2, "buy")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [["buy", "2026-11-09T02:00:10.400Z", 23300, 23300, 2, 1]]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "a trade Stockbit moves off the regular board inside its merge window leaves the page's sweeps, its minute emptied",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* page.settle
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // The only trade of its minute.
          ajaibTrade({
            number: 40002,
            time: "09:01:05",
            price: 23300,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.strictEqual(page.sweeps().length, 2)
        // Stockbit names it a cash-board trade.
        yield* day.trades([
          stockbitTrade({
            number: 40002,
            time: "09:01:05.000",
            price: 23300,
            lots: 3,
            side: "buy",
            board: "TN",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 2, 1]]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "a copy that changes a trade's side after its merge window, which the day's sweeps don't take, changes nothing on the page",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* page.settle
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        yield* TestClock.adjust("6 seconds")
        // The delta's tape carries Stockbit's copy, a sell.
        yield* day.trades([untr(40001, "09:00:10.000", 23300, 2, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(
          whole.map((sweep) => sweep.slice(0, 6)),
          [["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 2, 1]]
        )
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  it.effect(
    "a woken object sends a page that outlived it the minute a late trade changed",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* page.settle
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* day.evicted
        const woken = yield* tradingDay(sql, day.viewers)
        yield* woken.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.hear
        const whole = yield* fresh(woken, "UNTR")
        assert.strictEqual(whole.length, 3)
        assert.deepStrictEqual(page.sweeps(), whole)
        assert.strictEqual(page.asks(), 1)
      })
  )

  it.effect(
    "a page whose socket dropped while a late trade landed shows it once it connects again",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        yield* page.drop
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.reconnect
        yield* page.settle
        const whole = yield* fresh(day, "UNTR")
        assert.strictEqual(whole.length, 3)
        assert.deepStrictEqual(page.sweeps(), whole)
      })
  )

  // The measure behind the Decision on candles.ts `takeChanged`.
  it.effect(
    "a busy code's peak minute, 370 sweeps of 2,220 trades, costs its last delta under 24 KB of sweeps and its 240 deltas under 12 KB each on average",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:00")
        const day = yield* tradingDay()
        const viewer = yield* day.viewer("UNTR")
        // Each second's sweeps alternate sides, six trades each: six sweeps
        // a second, seven in every sixth.
        let number = 180_000
        const second = (index: number) =>
          Array.from({ length: (index % 6 === 0 ? 7 : 6) * 6 }, (_, trade) => {
            number += 3
            const side = Math.floor(trade / 6) % 2 === 0 ? "buy" : "sell"
            return stockbitTrade({
              number,
              time: `09:00:${String(index).padStart(2, "0")}.${String(trade * 23).padStart(3, "0")}`,
              price: side === "buy" ? 1_005 : 1_000,
              lots: 1 + ((number * 37) % 900),
              side,
            })
          })
        // The last delta's sweeps, how many and their bytes on the wire,
        // and the bytes of every delta's.
        let last = { sweeps: 0, bytes: 0 }
        let total = 0
        for (let index = 0; index < 60; index++) {
          const trades = second(index)
          for (let tick = 0; tick < 4; tick++) {
            yield* day.trades(
              trades.filter(
                (_, trade) => Math.floor((trade * 23) / 250) === tick
              )
            )
            yield* TestClock.adjust("250 millis")
            const sent = JSON.parse(viewer.sent.at(-1)!) as {
              readonly sweeps?: ReadonlyArray<{
                readonly sweeps: ReadonlyArray<unknown>
              }>
            }
            assert.isDefined(sent.sweeps)
            last = {
              sweeps: sent.sweeps[0]!.sweeps.length,
              bytes: new TextEncoder().encode(JSON.stringify(sent.sweeps))
                .length,
            }
            total += last.bytes
          }
        }
        assert.strictEqual(last.sweeps, 370)
        assert.isBelow(last.bytes, 24_000)
        assert.isBelow(total / 240, 12_000)
      })
  )

  it.effect("a sealed day answers its sweeps whole, cached", () =>
    Effect.gen(function* () {
      yield* at("09:01:10")
      const day = yield* tradingDay()
      yield* day.trades([
        untr(40001, "09:00:10.100", 23300, 2, "buy"),
        untr(40002, "09:00:40.000", 23300, 1, "sell"),
      ])
      yield* at("17:00:00")
      yield* day.alarm
      const { cacheControl, answer } = yield* day.recordedSweeps("UNTR")
      assert.strictEqual(cacheControl, SEALED_CACHE)
      assert.deepStrictEqual(answer.sweeps.map(sweepOf), [
        ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
        ["sell", "2026-11-09T02:00:40.000Z", 23300, 23300, 1, 1],
      ])
    })
  )
})
