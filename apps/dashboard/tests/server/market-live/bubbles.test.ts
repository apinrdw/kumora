// The bubbles GET (spec apinrdw/kumora#427, "Backfill GET", ticket
// apinrdw/kumora#429): Stockbit frames go in through the ingest socket, time
// moves only by TestClock, and the test reads the GET the page backfills
// Market Bubbles from.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, decodeRecordedBubbles } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeBubbleBook } from "@/server/market-live/bubble-book"

import { stockbitTrade, tradingDay, withLines } from "./day-harness"
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
    "carry a code's newest 60 minutes; after a restart the day totals and minutes come back from the stored candles and keep adding",
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
        assert.strictEqual(untr.minutes.length, 60)
        assert.strictEqual(untr.minutes[0]![0], minute("09:02"))
        assert.strictEqual(untr.minutes[59]![0], minute("10:01"))
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
        assert.deepStrictEqual(after, before)
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
        assert.strictEqual(added.minutes.length, 60)
        assert.strictEqual(added.minutes[0]![0], minute("09:03"))
      })
  )

  it.effect("answer 404 for a sealed day", () =>
    Effect.gen(function* () {
      yield* at("09:01:10")
      const day = yield* tradingDay()
      yield* day.trades([trade(40001, "09:00:10", "UNTR", 23300, 2, "buy")])
      yield* at("17:00:00")
      yield* day.alarm
      const { status } = yield* bubbles(day)
      assert.strictEqual(status, 404)
    })
  )

  // Decision: the cost check reads the answer's size and build time at a full
  // day, every code trading every minute, off this test's "Full day bubbles"
  // line (run it with `--silent=false`): a Worker's clock stands still while
  // it computes. Measured 2026-11-16 on the dev machine: 3.45 MB, about
  // 40 ms.
  it.live(
    "hold a code's newest 60 minutes at a full day, and build its answer",
    () =>
      Effect.gen(function* () {
        const book = makeBubbleBook({ days: [], minutes: [] })
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
        const built = yield* book.build(() => 12_000)
        const buildMs = performance.now() - start
        yield* Effect.logInfo("Full day bubbles").pipe(
          Effect.annotateLogs({ bytes: built.text.length, buildMs })
        )
        const answer = yield* decodeRecordedBubbles(built.text)
        assert.lengthOf(answer.codes, FULL_DAY_CODES)
        for (const entry of answer.codes) {
          assert.lengthOf(entry.minutes, 60)
          assert.strictEqual(
            entry.minutes[0]![0],
            first + (FULL_DAY_MINUTES - 60) * 60_000
          )
          assert.strictEqual(entry.day[2], 123 * FULL_DAY_MINUTES)
        }
      }),
    10_000
  )
})
