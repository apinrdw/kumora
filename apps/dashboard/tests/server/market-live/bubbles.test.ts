// The bubbles GET (spec apinrdw/kumora#427, "Backfill GET", ticket
// apinrdw/kumora#429): Stockbit frames go in through the ingest socket, time
// moves only by TestClock, and the test reads the GET the page backfills
// Market Bubbles from.
import { assert, describe, it } from "@effect/vitest"
import {
  BUBBLE_MINUTES,
  StockCode,
  ViewerProtocolVersion,
  decodeRecordedBubbles,
  encodeViewerUp,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  applyBubbles,
  applyMessage,
  bubblesOf,
  makeMarketFlow,
  missingFromBackfill,
  windowEnd,
  type BubbleWindow,
} from "@/lib/bubbles"
import { makeBubbleBook } from "@/server/market-live/bubble-book"

import { ajaibTrade, stockbitTrade, tradingDay, withLines } from "./day-harness"
import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
import { doubleField, messageField, stringField, varintField } from "./protobuf"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
const minute = (time: string) => DateTime.toEpochMillis(wib(`${time}:00`))

type Day = Effect.Success<ReturnType<typeof tradingDay>>

const trade = (
  number: number,
  time: string,
  code: string,
  price: number,
  lots: number,
  side?: "buy" | "sell",
  board?: "NG"
) =>
  stockbitTrade({
    number,
    time,
    code,
    price,
    lots,
    ...(side === undefined ? {} : { side }),
    ...(board === undefined ? {} : { board }),
  })

// A regular-board `liveprice` frame of a stock, with its previous close.
const stockPrice = (code: string, last: number, previous: number) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, code),
      ...doubleField(2, last),
      ...doubleField(3, 100_000),
      ...doubleField(7, 10),
      ...stringField(11, "2026-11-09T09:00:50+07:00"),
      ...doubleField(13, previous),
      ...doubleField(14, last * 100_000),
      ...varintField(23, 1),
    ])
  )

// An index's `liveprice` frame: no previous close, flagged an index.
const indexPrice = (code: string, last: number, time: string) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, code),
      ...doubleField(2, last),
      ...doubleField(3, 5_000_000),
      ...doubleField(7, 2_000),
      ...stringField(11, `2026-11-09T${time}+07:00`),
      ...doubleField(14, 9e9),
      ...varintField(18, 1),
    ])
  )

const bubbles = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({ _tag: "Bubbles" })
  const text = yield* Effect.promise(() => response.text())
  return {
    status: response.status,
    cacheControl: response.headers.get("Cache-Control"),
    text,
    answer:
      response.status === 200 ? yield* decodeRecordedBubbles(text) : undefined,
  }
})

// A Market Bubbles page on `day`: a viewer of `selected` (IHSG, as Market
// Bubbles selects) whose messages feed a market flow, which takes the
// backfill when asked.
const bubblesPage = Effect.fnUntraced(function* (day: Day, selected = "IHSG") {
  const socket = yield* day.viewer(selected)
  const flow = yield* makeMarketFlow()
  let fed = 0
  const settle = Effect.gen(function* () {
    const messages = yield* socket.received
    for (const message of messages.slice(fed))
      yield* applyMessage(flow, message)
    fed = messages.length
  })
  const backfill = Effect.gen(function* () {
    yield* applyBubbles(flow, (yield* bubbles(day)).answer!)
  })
  // Market Live's code switch: a Select on the same socket.
  const select = Effect.fnUntraced(function* (code: string) {
    yield* day.day.viewerMessage(
      socket,
      yield* encodeViewerUp({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make(code),
        watchlist: [],
      })
    )
  })
  // The page's backfill follow-up: at each of `times`, on the Worker's
  // clock, it asks again while the flow waits for a backfill.
  const follow = Effect.fnUntraced(function* (times: ReadonlyArray<string>) {
    for (const time of times) {
      yield* at(time)
      yield* settle
      if (yield* missingFromBackfill(flow)) yield* backfill
    }
    yield* settle
  })
  // A code's day value the page shows, and the one the Worker's backfill
  // carries once everything settled.
  const dayValue = Effect.fnUntraced(function* (code: string, end: number) {
    const shown = yield* bubblesOf(
      flow,
      { size: "value", colour: "delta", window: "D", top: "all" },
      end
    )
    return shown.find((bubble) => bubble.code === code)?.value
  })
  return { flow, settle, backfill, select, follow, dayValue }
})

const codeOf = (
  answer: Effect.Success<ReturnType<typeof bubbles>>["answer"],
  code: string
) => answer?.codes.find((entry) => entry.code === code)

describe("bubbles", () => {
  it.effect(
    "answer every code with a regular-board trade: its minutes' buy and sell value, its day totals and previous close, private for a minute",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.frames([
          stockPrice("UNTR", 23350, 23000),
          indexPrice("IHSG", 7100, "09:00:30"),
          indexPrice("IHSG", 7110, "09:01:00"),
        ])
        yield* day.trades([
          trade(40001, "09:00:10", "UNTR", 23300, 2, "buy"),
          trade(40002, "09:00:20", "UNTR", 23325, 1, "sell"),
          // No aggressor side: in value, in neither side's.
          trade(40003, "09:00:30", "UNTR", 23300, 3),
          trade(40004, "09:00:40", "BBCA", 8000, 7, "sell"),
          // The negotiated board counts in no figure.
          trade(40005, "09:00:45", "TLKM", 3000, 500, "buy", "NG"),
          trade(40006, "09:01:05", "UNTR", 23350, 1, "buy"),
        ])
        // Past the 09:02:05 flush.
        yield* TestClock.adjust("1 minute")
        const { status, cacheControl, answer } = yield* bubbles(day)
        assert.strictEqual(status, 200)
        assert.strictEqual(cacheControl, "private, max-age=60")
        assert.deepStrictEqual(answer, {
          settledBefore: DateTime.toEpochMillis(wib("09:02:05")),
          codes: [
            {
              code: StockCode.make("BBCA"),
              day: [5_600_000, 7, 1, 0, 5_600_000, 8000],
              minutes: [[minute("09:00"), 5_600_000, 7, 1, 0, 5_600_000, 8000]],
            },
            {
              code: StockCode.make("UNTR"),
              previousClose: 23000,
              day: [16_317_500, 7, 4, 6_995_000, 2_332_500, 23350],
              minutes: [
                [
                  minute("09:00"),
                  13_982_500,
                  6,
                  3,
                  4_660_000,
                  2_332_500,
                  23300,
                ],
                [minute("09:01"), 2_335_000, 1, 1, 2_335_000, 0, 23350],
              ],
            },
          ],
        })
      })
  )

  it.effect(
    "built once a minute: requests before the next flush share one body, and the next flush's carries what came since",
    () =>
      withLines("Bubbles built", (lines) =>
        Effect.gen(function* () {
          yield* at("09:01:10")
          const day = yield* tradingDay()
          yield* day.trades([trade(40001, "09:01:01", "UNTR", 23300, 2, "buy")])
          yield* TestClock.adjust("1 minute")
          const built = lines.length
          const first = yield* bubbles(day)
          yield* day.trades([
            trade(40002, "09:02:08", "UNTR", 23325, 4, "sell"),
          ])
          yield* TestClock.adjust("30 seconds")
          const second = yield* bubbles(day)
          assert.strictEqual(second.text, first.text)
          assert.strictEqual(lines.length, built)
          // Past the 09:03:05 flush.
          yield* TestClock.adjust("30 seconds")
          const next = yield* bubbles(day)
          assert.deepStrictEqual(codeOf(next.answer, "UNTR")?.minutes, [
            [minute("09:01"), 4_660_000, 2, 1, 4_660_000, 0, 23300],
            [minute("09:02"), 9_330_000, 4, 1, 0, 9_330_000, 23325],
          ])
          // Each build logs its size.
          const line = lines.at(-1)!
          assert.strictEqual(line.codes, 1)
          assert.strictEqual(line.bytes, next.text.length)
        })
      )
  )

  it.effect(
    "a late trade in a minute already flushed shows in the next build, minute and day",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades([trade(40002, "09:00:20", "UNTR", 23300, 2, "buy")])
        // Past two flushes: the 09:00 minute is stored and let go.
        yield* TestClock.adjust("2 minutes")
        yield* day.trades([trade(40001, "09:00:10", "UNTR", 23200, 1, "sell")])
        yield* TestClock.adjust("1 minute")
        const untr = codeOf((yield* bubbles(day)).answer, "UNTR")
        assert.deepStrictEqual(untr?.minutes, [
          [minute("09:00"), 6_980_000, 3, 2, 4_660_000, 2_320_000, 23300],
        ])
        // The last price stays the highest trade number's.
        assert.deepStrictEqual(
          untr?.day,
          [6_980_000, 3, 2, 4_660_000, 2_320_000, 23300]
        )
      })
  )

  it.effect(
    "settled before the oldest trade still in its merge window at the build, or the build with none",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:02")
        const day = yield* tradingDay()
        yield* day.trades([trade(40001, "09:01:02", "UNTR", 23300, 2, "buy")])
        yield* at("09:01:06")
        const first = (yield* bubbles(day)).answer
        assert.strictEqual(
          first?.settledBefore,
          DateTime.toEpochMillis(wib("09:01:02"))
        )
        assert.isUndefined(codeOf(first, "UNTR"))
        yield* at("09:02:06")
        const next = (yield* bubbles(day)).answer
        assert.strictEqual(
          next?.settledBefore,
          DateTime.toEpochMillis(wib("09:02:05"))
        )
        assert.isDefined(codeOf(next, "UNTR"))
      })
  )

  it.effect(
    "carry the close before the hour of a code that traded every minute of it, so a fresh page's 1h change is against it",
    () =>
      Effect.gen(function* () {
        yield* at("10:02:10")
        const day = yield* tradingDay()
        yield* day.frames([stockPrice("UNTR", 24525, 20000)])
        // One UNTR trade each minute from 09:00 to 10:01, 25 up each time.
        yield* day.trades(
          Array.from({ length: 62 }, (_, index) =>
            trade(
              40001 + index,
              `${String(9 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:30`,
              "UNTR",
              23000 + index * 25,
              1,
              "buy"
            )
          )
        )
        yield* TestClock.adjust("1 minute")
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(flow, (yield* bubbles(day)).answer!)
        // 10:01:59: 1h is 09:02 to 10:01, against 09:01's close, 23025.
        const [untr] = yield* bubblesOf(
          flow,
          { size: "value", colour: "change", window: "1h", top: "all" },
          minute("10:01") + 59_000
        )
        assert.closeTo(untr!.change!, ((24525 - 23025) / 23025) * 100, 1e-9)
      })
  )

  it.effect(
    "carry a code's newest 61 minutes; after a restart the day totals and minutes come back from the stored candles and keep adding",
    () =>
      Effect.gen(function* () {
        yield* at("10:02:10")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        // One UNTR trade each minute from 09:00 to 10:01, and one of BBCA.
        const rows = Array.from({ length: 62 }, (_, index) => {
          const hour = 9 + Math.floor(index / 60)
          const time = `${String(hour).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:30`
          return trade(
            40001 + index,
            time,
            "UNTR",
            23000 + index * 25,
            1,
            "buy"
          )
        })
        yield* day.trades([
          ...rows,
          trade(40100, "09:30:00", "BBCA", 8000, 3, "sell"),
        ])
        yield* TestClock.adjust("1 minute")
        const before = (yield* bubbles(day)).answer
        const untr = codeOf(before, "UNTR")!
        assert.strictEqual(untr.minutes.length, 61)
        assert.strictEqual(untr.minutes[0]![0], minute("09:01"))
        assert.strictEqual(untr.minutes[60]![0], minute("10:01"))
        assert.deepStrictEqual(untr.day.slice(1), [
          62,
          62,
          untr.day[0],
          0,
          24525,
        ])

        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const after = (yield* bubbles(restarted)).answer
        assert.deepStrictEqual(after?.codes, before?.codes)
        // The day totals match a re-sum of the stored candles.
        for (const entry of after!.codes) {
          const { candles } = (yield* restarted.recordedCandles(entry.code))
            .answer
          const sum = (pick: (candle: (typeof candles)[number]) => number) =>
            candles.reduce((total, candle) => total + pick(candle), 0)
          assert.deepStrictEqual(entry.day, [
            sum((candle) => candle.value),
            sum((candle) => candle.volume),
            sum((candle) => candle.frequency),
            sum((candle) => candle.buyValue),
            sum((candle) => candle.sellValue),
            candles.at(-1)!.close,
          ])
        }

        yield* restarted.trades([
          trade(40200, "10:03:20", "UNTR", 24600, 2, "sell"),
        ])
        yield* TestClock.adjust("1 minute")
        const added = codeOf((yield* bubbles(restarted)).answer, "UNTR")!
        assert.deepStrictEqual(added.day, [
          untr.day[0] + 4_920_000,
          64,
          63,
          untr.day[0],
          4_920_000,
          24600,
        ])
        assert.strictEqual(added.minutes.length, 61)
        assert.strictEqual(added.minutes[0]![0], minute("09:02"))
      })
  )

  it.effect(
    "a page fed by an IHSG viewer and the backfill shows the book's figures after Stockbit re-sides, retimes and re-boards Ajaib's trades",
    () =>
      Effect.gen(function* () {
        yield* at("09:02:10")
        const day = yield* tradingDay()
        const page = yield* bubblesPage(day)
        yield* page.settle
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:01:05",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          ajaibTrade({
            number: 40002,
            time: "09:01:59",
            price: 23325,
            lots: 3,
            side: "buy",
          }),
          // The only trade of its minute.
          ajaibTrade({
            number: 40003,
            time: "09:00:50",
            price: 23300,
            lots: 1,
            side: "buy",
          }),
          ajaibTrade({
            number: 40004,
            time: "09:02:05",
            price: 23350,
            lots: 4,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        // Stockbit's copies, inside the merge window: 40001 a sell, 40002
        // into 09:02, 40003 and 40004 cash-board trades.
        yield* day.trades([
          trade(40001, "09:01:05.000", "UNTR", 23300, 2, "sell"),
          trade(40002, "09:02:00.500", "UNTR", 23325, 3, "buy"),
          stockbitTrade({
            number: 40003,
            time: "09:00:50.000",
            price: 23300,
            lots: 1,
            side: "buy",
            board: "TN",
          }),
          stockbitTrade({
            number: 40004,
            time: "09:02:05.000",
            price: 23350,
            lots: 4,
            side: "buy",
            board: "TN",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const shown = Effect.fnUntraced(function* (
          window: BubbleWindow,
          end: number
        ) {
          return (yield* bubblesOf(
            page.flow,
            { size: "value", colour: "delta", window, top: "all" },
            end
          )).map(({ code, value, frequency, buyValue, sellValue }) => ({
            code,
            value,
            frequency,
            buyValue,
            sellValue,
          }))
        })
        const sold = { value: 4_660_000, buyValue: 0, sellValue: 4_660_000 }
        const bought = { value: 6_997_500, buyValue: 6_997_500, sellValue: 0 }
        const untr = StockCode.make("UNTR")
        const book = Effect.gen(function* () {
          assert.deepStrictEqual(yield* shown("D", minute("09:02")), [
            {
              code: untr,
              value: sold.value + bought.value,
              frequency: 2,
              buyValue: bought.buyValue,
              sellValue: sold.sellValue,
            },
          ])
          assert.deepStrictEqual(
            yield* shown("1m", minute("09:00") + 59_999),
            []
          )
          assert.deepStrictEqual(yield* shown("1m", minute("09:01") + 59_999), [
            { code: untr, frequency: 1, ...sold },
          ])
          assert.deepStrictEqual(yield* shown("1m", minute("09:02") + 59_999), [
            { code: untr, frequency: 1, ...bought },
          ])
          // 09:01:41 to 09:02:10.
          assert.deepStrictEqual(
            yield* shown("30s", minute("09:02") + 10_500),
            [{ code: untr, frequency: 1, ...bought }]
          )
        })
        yield* book
        // The first ask builds the body before any trade settled.
        yield* page.backfill
        yield* book
        // Past the merge windows and the 09:03:05 build.
        yield* TestClock.adjust("1 minute")
        yield* page.settle
        yield* page.backfill
        yield* book
      })
  )

  it.effect(
    "a page opened 2 s after a trade counts it once a build settled past its snapshot",
    () =>
      Effect.gen(function* () {
        yield* at("09:10:01")
        const day = yield* tradingDay()
        yield* day.frames([stockPrice("UNTR", 23300, 23000)])
        yield* day.trades([trade(40001, "09:10:01", "UNTR", 23300, 2, "buy")])
        yield* at("09:10:03")
        const page = yield* bubblesPage(day)
        yield* page.settle
        yield* page.backfill
        // A second past the 09:10:05 build, which the trade's merge window
        // missed.
        yield* at("09:10:06")
        yield* page.settle
        yield* page.backfill
        yield* page.follow(["09:11:06", "09:12:06"])
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:12")),
          4_660_000
        )
        assert.isFalse(yield* missingFromBackfill(page.flow))
      })
  )

  it.effect(
    "Market Live's code switch keeps a trade its socket carried until a build settled past the switch",
    () =>
      Effect.gen(function* () {
        yield* at("09:09:50")
        const day = yield* tradingDay()
        yield* day.frames([stockPrice("UNTR", 23300, 23000)])
        const page = yield* bubblesPage(day, "BBCA")
        yield* page.settle
        yield* page.backfill
        yield* at("09:10:01")
        yield* day.trades([trade(40001, "09:10:01", "UNTR", 23300, 2, "buy")])
        yield* at("09:10:02")
        yield* page.settle
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:10")),
          4_660_000
        )
        yield* at("09:10:03")
        yield* page.select("TLKM")
        yield* page.settle
        yield* page.backfill
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:10")),
          4_660_000
        )
        yield* at("09:10:06")
        yield* page.settle
        yield* page.backfill
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:10")),
          4_660_000
        )
        yield* page.follow(["09:11:06", "09:12:06"])
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:12")),
          4_660_000
        )
        assert.isFalse(yield* missingFromBackfill(page.flow))
      })
  )

  it.effect(
    "a page whose clock runs 2 s fast, asking before the build, asks again until a build settled past its snapshot",
    () =>
      Effect.gen(function* () {
        yield* at("09:09:50")
        const day = yield* tradingDay()
        yield* day.frames([
          stockPrice("BBCA", 8000, 7900),
          stockPrice("UNTR", 23300, 23000),
        ])
        yield* day.trades([trade(40000, "09:09:50", "BBCA", 8000, 1, "buy")])
        yield* at("09:10:20")
        yield* day.trades([trade(40001, "09:10:20", "UNTR", 23300, 2, "buy")])
        yield* at("09:10:30")
        const page = yield* bubblesPage(day)
        yield* page.settle
        yield* page.backfill
        // 09:11:06 on the browser's clock is 09:11:04 on the Worker's: the
        // 09:10:05 build is still the newest.
        yield* at("09:11:04")
        yield* page.settle
        yield* page.backfill
        yield* page.follow(["09:12:04", "09:13:04"])
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("09:13")),
          4_660_000
        )
        assert.isFalse(yield* missingFromBackfill(page.flow))
      })
  )

  it.effect(
    "a recount a late trade asks for 3 s before a build waits for a build settled past it",
    () =>
      Effect.gen(function* () {
        yield* at("10:29:00")
        const day = yield* tradingDay()
        yield* day.frames([
          stockPrice("BBCA", 8000, 7900),
          stockPrice("UNTR", 23300, 23000),
        ])
        yield* day.trades([
          trade(40001, "09:05:00", "UNTR", 23300, 2, "buy"),
          trade(40002, "10:29:00", "BBCA", 8000, 1, "buy"),
        ])
        yield* at("10:29:30")
        const page = yield* bubblesPage(day)
        yield* page.settle
        yield* page.backfill
        yield* page.follow(["10:30:06"])
        assert.isFalse(yield* missingFromBackfill(page.flow))
        // A late trade in 09:05, older than the hour the page keeps.
        yield* at("10:31:02")
        yield* day.trades([trade(40000, "09:05:30", "UNTR", 23200, 1, "sell")])
        yield* at("10:31:03")
        yield* page.settle
        assert.isTrue(yield* missingFromBackfill(page.flow))
        yield* at("10:31:06")
        yield* page.settle
        yield* page.backfill
        yield* page.follow(["10:32:06", "10:33:06"])
        assert.strictEqual(
          yield* page.dayValue("UNTR", minute("10:33")),
          4_660_000 + 2_320_000
        )
        assert.isFalse(yield* missingFromBackfill(page.flow))
      })
  )

  it.effect(
    "after the seal, a page opened before midnight shows the day's map up to its last trade",
    () =>
      Effect.gen(function* () {
        yield* at("16:59:58")
        const day = yield* tradingDay()
        yield* day.trades([trade(40001, "16:59:58", "UNTR", 23300, 2, "buy")])
        // Built while the trade is in its merge window: only the seal's
        // flush settles it.
        yield* at("16:59:59")
        yield* bubbles(day)
        yield* at("17:00:00")
        yield* day.alarm
        yield* at("17:05:00")
        const page = yield* bubblesPage(day)
        yield* page.settle
        const answer = yield* bubbles(day)
        assert.strictEqual(answer.status, 200)
        assert.strictEqual(answer.cacheControl, "private, max-age=60")
        yield* page.backfill
        const end = yield* windowEnd(
          page.flow,
          "closed",
          DateTime.toEpochMillis(wib("17:05:00"))
        )
        assert.deepStrictEqual(end, {
          end: DateTime.toEpochMillis(wib("16:59:58")),
          closed: true,
        })
        assert.strictEqual(yield* page.dayValue("UNTR", end!.end), 4_660_000)
      })
  )

  it.effect(
    "after the seal, an object restarted before midnight answers the day's bubbles from its candles",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("15:49:50")
        const recording = yield* tradingDay(sql)
        yield* recording.trades([
          trade(40001, "15:49:50", "UNTR", 23300, 2, "buy"),
        ])
        yield* at("17:00:00")
        yield* recording.alarm
        yield* at("17:05:00")
        const answer = yield* bubbles(yield* tradingDay(sql))
        assert.strictEqual(answer.status, 200)
        assert.deepStrictEqual(
          codeOf(answer.answer, "UNTR")?.day,
          [4_660_000, 2, 1, 4_660_000, 0, 23300]
        )
      })
  )

  it.effect("answer 404 for a past day, restarted or not", () =>
    Effect.gen(function* () {
      const sql = memorySql()
      yield* at("09:01:10")
      const day = yield* tradingDay(sql)
      yield* day.trades([trade(40001, "09:00:10", "UNTR", 23300, 2, "buy")])
      yield* at("17:00:00")
      yield* day.alarm
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-10T00:00:01+07:00"))
      )
      assert.strictEqual((yield* bubbles(day)).status, 404)
      assert.strictEqual((yield* bubbles(yield* tradingDay(sql))).status, 404)
    })
  )

  // Decision: the cost check reads the answer's size and build time at a full
  // day, every code trading every minute, off this test's "Full day bubbles"
  // line (run it with `--silent=false`): a Worker's clock stands still while
  // it computes. Measured 2026-11-16 on the dev machine: 3.51 MB, about
  // 40 ms.
  it.live(
    "hold a code's newest BUBBLE_MINUTES at a full day, and build its answer",
    () =>
      Effect.gen(function* () {
        const book = yield* makeBubbleBook({ days: [], minutes: [] })
        const first = minute("08:58")
        let order = 0n
        for (let index = 0; index < FULL_DAY_MINUTES; index++)
          for (let code = 0; code < FULL_DAY_CODES; code++) {
            order++
            const figures = {
              openOrder: order,
              open: 12_345,
              closeOrder: order,
              close: 12_345,
              closeTime: 0,
              high: 12_345,
              low: 12_345,
              volume: 1_234,
              value: 1_523_456_789,
              buyValue: 823_456_789,
              sellValue: 700_000_000,
              frequency: 123,
            }
            book.settled(
              StockCode.make(`C${String(code).padStart(3, "0")}`),
              first + index * 60_000,
              figures,
              figures
            )
          }
        const start = performance.now()
        const built = yield* book.build(first, () => 12_000)
        const buildMs = performance.now() - start
        yield* Effect.logInfo("Full day bubbles").pipe(
          Effect.annotateLogs({ bytes: built.text.length, buildMs })
        )
        const answer = yield* decodeRecordedBubbles(built.text)
        assert.lengthOf(answer.codes, FULL_DAY_CODES)
        for (const entry of answer.codes) {
          assert.lengthOf(entry.minutes, BUBBLE_MINUTES)
          assert.strictEqual(
            entry.minutes[0]![0],
            first + (FULL_DAY_MINUTES - BUBBLE_MINUTES) * 60_000
          )
          assert.strictEqual(entry.day[2], 123 * FULL_DAY_MINUTES)
        }
      }),
    10_000
  )
})
