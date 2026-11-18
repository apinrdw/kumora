// Book events through the trading-day object (spec apinrdw/kumora#517,
// "Book events"): Stockbit book frames go in through the ingest socket, time
// moves only by TestClock, and the test reads what viewers and the recorded
// day GET receive.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  decodeRecordedBookEvents,
  decodeViewerDown,
  recordedDayPath,
  recordedDayRequest,
  type BookEvent,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { SEALED_CACHE } from "@/server/market-live/routes"

import {
  ajaibTrade,
  stockbitBook,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { memorySql } from "./sql"

const UNTR = StockCode.make("UNTR")

const at = (time: string) =>
  TestClock.setTime(Date.parse(`2026-11-09T${time}+07:00`))

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// Ten 1,000-lot bids from 1000 down; at 990, a wall of 6,000 lots in 2
// orders when `wall`.
const bids = (time: string, wall: boolean) =>
  stockbitBook({
    side: "BID",
    time,
    levels: Array.from({ length: 10 }, (_, k) => {
      const price = 1000 - 5 * k
      return wall && price === 990
        ? ([price, 2, 6000] as const)
        : ([price, 10, 1000] as const)
    }),
  })

const OFFERS = stockbitBook({
  side: "OFFER",
  time: "09:09:59.000",
  levels: [
    [1005, 10, 900],
    [1010, 10, 900],
  ],
})

// Bid frames every 5 s from 09:10:00, so no relay gap opens, then one at
// 09:10:31 where 990 became a wall: the window from 09:10:01 reads it
// against the 09:10:00 frame. Each frame is sent at its time and served
// with the delta after it.
const wallAppears = (day: Day, hour = "09") =>
  Effect.gen(function* () {
    for (const second of [0, 5, 10, 15, 20, 25, 30, 31]) {
      const time = `${hour}:10:${String(second).padStart(2, "0")}.000`
      yield* at(time)
      const frame = bids(time, second === 31)
      // One trade below the wall, so the day's tape is the relay's.
      if (second === 0)
        yield* day.trades([
          stockbitTrade({
            number: 1,
            time: `${hour}:10:00`,
            price: 1000,
            lots: 1,
            side: "sell",
          }),
        ])
      yield* day.frames(second === 0 ? [frame, OFFERS] : [frame])
      yield* TestClock.adjust("300 millis")
    }
  })

const received = (socket: { readonly sent: ReadonlyArray<string> }) =>
  Effect.forEach(socket.sent, (text) => decodeViewerDown(text))

const deltaEvents = (socket: { readonly sent: ReadonlyArray<string> }) =>
  Effect.map(received(socket), (messages) =>
    messages.flatMap((message) =>
      message._tag === "Delta" ? (message.bookEvents ?? []) : []
    )
  )

const named = (events: ReadonlyArray<BookEvent>) =>
  events.map((event) => [
    event.kind,
    event.code,
    event.side,
    event.price,
    DateTime.formatIso(DateTime.add(event.at, { hours: 7 })).slice(11, 19),
  ])

const APPEARED = [["appeared", "UNTR", "bid", 990, "09:10:31"]]

const recordedEvents = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({ _tag: "BookEvents", code: UNTR })
  return {
    cacheControl: response.headers.get("Cache-Control"),
    answer: yield* decodeRecordedBookEvents(
      yield* Effect.promise(() => response.text())
    ),
  }
})

describe("book events", () => {
  it.effect("the GET's path reads back as its resource", () =>
    Effect.gen(function* () {
      const resource = { _tag: "BookEvents" as const, code: UNTR }
      const path = yield* recordedDayPath(WibDate.make("2026-11-09"), resource)
      assert.strictEqual(path, "/market-live/days/2026-11-09/book-events/UNTR")
      const read = yield* recordedDayRequest(
        new URL(`https://kumora.test${path}`)
      )
      assert.deepStrictEqual(Option.getOrUndefined(read)?.resource, resource)
    })
  )

  it.effect(
    "an event goes out in the next delta, is stored, and comes back in snapshots and the GET",
    () =>
      Effect.gen(function* () {
        yield* at("09:09:59.000")
        const day = yield* tradingDay()
        const page = yield* day.viewer("BBCA")
        yield* wallAppears(day)
        assert.deepStrictEqual(named(yield* deltaEvents(page)), APPEARED)
        assert.deepInclude((yield* deltaEvents(page))[0], {
          lots: 6000,
          orders: 2,
          ticks: 2,
        })
        const [snapshot] = yield* received(yield* day.viewer("UNTR"))
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(named(snapshot.bookEvents ?? []), APPEARED)
        assert.deepStrictEqual(
          named(snapshot.selectedBookEvents ?? []),
          APPEARED
        )
        const [other] = yield* received(yield* day.viewer("BBCA"))
        assert(other?._tag === "Snapshot")
        assert.strictEqual(other.selectedBookEvents, undefined)

        const unflushed = yield* recordedEvents(day)
        assert.strictEqual(unflushed.cacheControl, "no-store")
        assert.deepStrictEqual(named(unflushed.answer.events), APPEARED)
        assert.isTrue(unflushed.answer.recorded)
        // Flushed 5 s past the minute.
        yield* at("09:11:06.000")
        yield* TestClock.adjust("1 second")
        yield* at("17:00:00.000")
        yield* day.alarm
        const sealed = yield* recordedEvents(day)
        assert.strictEqual(sealed.cacheControl, SEALED_CACHE)
        assert.deepStrictEqual(named(sealed.answer.events), APPEARED)
        assert.isTrue(sealed.answer.recorded)
      })
  )

  it.effect(
    "a restarted object's snapshot still carries the day's events",
    () =>
      Effect.gen(function* () {
        yield* at("09:09:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* wallAppears(day)
        yield* at("09:11:06.000")
        yield* TestClock.adjust("1 second")
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* received(yield* restarted.viewer("UNTR"))
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(named(snapshot.bookEvents ?? []), APPEARED)
        assert.deepStrictEqual(
          named(snapshot.selectedBookEvents ?? []),
          APPEARED
        )
      })
  )

  it.effect(
    "a trade Stockbit corrects after Ajaib's copy counts as Stockbit's",
    () =>
      Effect.gen(function* () {
        // Bid frames every 5 s from 09:10:00 and, at 09:10:22, trade 2:
        // 1,000 lots at the best bid, Stockbit's sell, after Ajaib's buy
        // when `ajaibFirst`. The 09:10:30 frame reads it as absorbed.
        const events = Effect.fnUntraced(function* (ajaibFirst: boolean) {
          yield* at("09:09:59.000")
          const day = yield* tradingDay()
          const page = yield* day.viewer("BBCA")
          for (const second of [0, 5, 10, 15, 20, 25, 30]) {
            const time = `09:10:${String(second).padStart(2, "0")}.000`
            yield* at(time)
            if (second === 0)
              yield* day.trades([
                stockbitTrade({
                  number: 1,
                  time: "09:10:00",
                  price: 1000,
                  lots: 1,
                  side: "sell",
                }),
              ])
            yield* day.frames(
              second === 0 ? [bids(time, false), OFFERS] : [bids(time, false)]
            )
            yield* TestClock.adjust("300 millis")
            if (second !== 20) continue
            yield* at("09:10:22.000")
            if (ajaibFirst)
              yield* day.ajaibTrades([
                ajaibTrade({
                  number: 2,
                  time: "09:10:22",
                  price: 1000,
                  lots: 1000,
                  side: "buy",
                }),
              ])
            yield* TestClock.adjust("500 millis")
            yield* day.trades([
              stockbitTrade({
                number: 2,
                time: "09:10:22.500",
                price: 1000,
                lots: 1000,
                side: "sell",
              }),
            ])
            yield* TestClock.adjust("300 millis")
          }
          return named(yield* deltaEvents(page))
        })
        const stockbitOnly = yield* events(false)
        assert.deepStrictEqual(stockbitOnly, [
          ["absorbed", "UNTR", "bid", 1000, "09:10:30"],
        ])
        assert.deepStrictEqual(yield* events(true), stockbitOnly)
      })
  )

  it.effect("no event is read in the lunch break", () =>
    Effect.gen(function* () {
      yield* at("12:09:59.000")
      const day = yield* tradingDay()
      const page = yield* day.viewer("UNTR")
      yield* wallAppears(day, "12")
      assert.deepStrictEqual(yield* deltaEvents(page), [])
    })
  )

  it.effect(
    "a day sealed before book events answers none, marked not recorded",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("09:09:59.000")
        const day = yield* tradingDay(sql)
        yield* at("17:00:00.000")
        yield* day.alarm
        yield* day.evicted
        sql.exec("DELETE FROM facts WHERE key = 'book-events'")
        yield* TestClock.setTime(Date.parse("2026-11-10T10:00:00+07:00"))
        const older = yield* recordedEvents(yield* tradingDay(sql))
        assert.deepStrictEqual(older.answer, {
          code: UNTR,
          recorded: false,
          events: [],
        })
      })
  )
})
