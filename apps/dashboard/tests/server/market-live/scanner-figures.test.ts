// The scanner's figures through the trading-day object (spec
// apinrdw/kumora#517, "Data"): books, `liveprice` frames and trades go in
// through the ingest socket in an order that once left pages stale, time
// moves only by TestClock, and every connected page must hold what a fresh
// snapshot would give it.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, decodeViewerDown } from "@workspace/relay"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeFiguresStore } from "@/components/order-book-radar/figures-store"

import {
  ajaibTrade,
  stockbitBook,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { doubleField, messageField, stringField, varintField } from "./protobuf"

const UNTR = StockCode.make("UNTR")

const at = (time: string) =>
  TestClock.setTime(Date.parse(`2026-11-09T${time}+07:00`))

type Day = Effect.Success<ReturnType<typeof tradingDay>>
type Page = Effect.Success<ReturnType<Day["viewer"]>>

// UNTR's regular-board `liveprice` frame as of `time`, with its previous
// close.
const livePrice = (time: string, last: number, previous: number) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, "UNTR"),
      ...doubleField(2, last),
      ...doubleField(3, 100_000),
      ...doubleField(7, 10),
      ...stringField(11, `2026-11-09T${time}+07:00`),
      ...doubleField(13, previous),
      ...doubleField(14, last * 100_000),
      ...varintField(23, 1),
    ])
  )

const book = (time: string) => [
  stockbitBook({ side: "BID", time, levels: [[1000, 10, 1000]] }),
  stockbitBook({ side: "OFFER", time, levels: [[1005, 10, 1000]] }),
]

// Ajaib's `ORDER_BOOK_CUSTOM` frame of `code`'s whole book as of `time`.
const ajaibBook = (code: string, time: string) =>
  JSON.stringify({
    ticker: code,
    is_initial: "true",
    buy: [{ price: 5000, lot: 1000, num: 10 }],
    sell: [{ price: 5025, lot: 1000, num: 10 }],
    updateTime: Date.parse(`2026-11-09T${time}+07:00`),
  })

// Ajaib's `PRICE` frame of `code` as of `time`, with its previous close.
const ajaibPrice = (
  code: string,
  time: string,
  last: number,
  previous: number
) =>
  JSON.stringify({
    ticker: code,
    price: last,
    change: last - previous,
    pctChange: (last - previous) / previous,
    tradableVolume: 100_000,
    hi: last,
    lo: last,
    open: previous,
    close: previous,
    updateTime: Date.parse(`2026-11-09T${time}+07:00`),
  })

// A code's figures as `socket`'s page holds them from every message it was
// sent, as [last, previous close, previous value].
const held = Effect.fnUntraced(function* (socket: Page, code = UNTR) {
  const store = yield* makeFiguresStore
  for (const text of socket.sent) store.apply(yield* decodeViewerDown(text))
  const figures = store.all().get(code)
  return [figures?.last, figures?.previousClose, figures?.previousValue]
})

// What a page connecting now would hold.
const fresh = Effect.fnUntraced(function* (day: Day) {
  const socket = yield* day.viewer("IHSG")
  const figures = yield* held(socket)
  yield* day.left(socket)
  return figures
})

describe("the scanner's figures", () => {
  it.effect(
    "on every connected page match a fresh snapshot's after each delta",
    () =>
      Effect.gen(function* () {
        yield* at("09:09:59.000")
        const day = yield* tradingDay()
        const pages = new Map<string, Page>()
        // A page connecting, or what the relay sends.
        const steps: ReadonlyArray<
          readonly [string, string, Effect.Effect<void, unknown>?]
        > = [
          ["09:10:00.000", "page A"],
          ["09:10:01.000", "UNTR's first book", day.frames(book("09:10:01"))],
          [
            "09:10:05.000",
            "UNTR's first liveprice",
            day.frames([livePrice("09:10:05", 1000, 1100)]),
          ],
          [
            "09:10:10.000",
            "a trade at 1,005",
            day.trades([
              stockbitTrade({
                number: 5,
                time: "09:10:10",
                price: 1005,
                lots: 1,
                side: "buy",
              }),
            ]),
          ],
          ["09:10:15.000", "page B"],
          [
            "09:10:20.000",
            "a late 09:05 trade at 990",
            day.trades([
              stockbitTrade({
                number: 2,
                time: "09:05:00",
                price: 990,
                lots: 1,
                side: "sell",
              }),
            ]),
          ],
          [
            "09:10:25.000",
            "a liveprice at 1,010",
            day.frames([livePrice("09:10:25", 1010, 1100)]),
          ],
        ]
        const stale: Array<string> = []
        for (const [time, step, run] of steps) {
          yield* at(time)
          if (run === undefined) pages.set(step, yield* day.viewer("IHSG"))
          else yield* run
          yield* TestClock.adjust("300 millis")
          const want = yield* fresh(day)
          for (const [page, socket] of pages) {
            const got = yield* held(socket)
            if (JSON.stringify(got) !== JSON.stringify(want))
              stale.push(
                `after ${step}, ${page} holds ${JSON.stringify(got)}, not ${JSON.stringify(want)}`
              )
          }
        }
        assert.deepStrictEqual(stale, [], "every page held the current figures")
      })
  )
  it.effect("follow Ajaib's trades while Stockbit is stale", () =>
    Effect.gen(function* () {
      yield* at("09:10:00.000")
      const day = yield* tradingDay()
      const page = yield* day.viewer("IHSG")
      yield* day.frames([
        ...book("09:10:00"),
        livePrice("09:10:00", 1000, 1100),
      ])
      yield* TestClock.adjust("300 millis")
      assert.deepStrictEqual((yield* held(page)).slice(0, 2), [1000, 1100])
      // 20 s without a Stockbit frame: stale. Ajaib still trades UNTR.
      yield* at("09:10:20.000")
      yield* day.ajaibTrades([
        ajaibTrade({
          number: 9,
          time: "09:10:20",
          price: 1020,
          lots: 1,
          side: "buy",
        }),
      ])
      yield* TestClock.adjust("300 millis")
      assert.deepStrictEqual(
        (yield* held(page)).slice(0, 2),
        [1020, 1100],
        "the page holds Ajaib's last trade"
      )
      // A newer trade moves the price; a late, older one doesn't.
      yield* at("09:10:21.000")
      yield* day.ajaibTrades([
        ajaibTrade({
          number: 10,
          time: "09:10:21",
          price: 1015,
          lots: 1,
          side: "sell",
        }),
        ajaibTrade({
          number: 8,
          time: "09:10:19",
          price: 990,
          lots: 1,
          side: "sell",
        }),
      ])
      yield* TestClock.adjust("300 millis")
      assert.deepStrictEqual((yield* held(page)).slice(0, 2), [1015, 1100])
      assert.deepStrictEqual(yield* held(page), yield* fresh(day))
    })
  )

  it.effect("of a code Stockbit never priced come from Ajaib", () =>
    Effect.gen(function* () {
      yield* at("09:10:00.000")
      const day = yield* tradingDay()
      const page = yield* day.viewer("IHSG")
      const ASII = StockCode.make("ASII")
      const ADRO = StockCode.make("ADRO")
      yield* day.ajaibTrades([
        ajaibBook("ASII", "09:10:00"),
        ajaibPrice("ASII", "09:10:00", 5000, 4900),
        ajaibBook("ADRO", "09:10:00"),
        ajaibTrade({
          number: 11,
          time: "09:10:00",
          code: "ADRO",
          price: 5010,
          lots: 1,
          side: "sell",
        }),
      ])
      yield* TestClock.adjust("300 millis")
      assert.deepStrictEqual(
        [
          (yield* held(page, ASII)).slice(0, 2),
          (yield* held(page, ADRO)).slice(0, 2),
        ],
        [
          [5000, 4900],
          [5010, undefined],
        ],
        "the page holds Ajaib's PRICE and last trade"
      )
    })
  )
})
