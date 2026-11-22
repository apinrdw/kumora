// Order flow events through the trading-day object (spec apinrdw/kumora#605,
// "Order flow events: data"): Stockbit trades go in through the ingest
// socket, time moves only by TestClock, and the test reads what viewers
// receive. The minutes are order-flow.test.ts's push example on UNTR, with a
// 1-lot BBCA trade every 10 s so no relay gap opens.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  decodeRecordedOrderFlowEvents,
  decodeViewerDown,
  recordedDayPath,
  recordedDayRequest,
  type OrderFlowEvent,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { SEALED_CACHE } from "@/server/market-live/routes"

import { tradingDay } from "./day-harness"
import { PUSH, at, push, pushJudged, trade } from "./order-flow-push"
import { memorySql } from "./sql"

const UNTR = StockCode.make("UNTR")

type Day = Effect.Success<ReturnType<typeof tradingDay>>

const received = (socket: { readonly sent: ReadonlyArray<string> }) =>
  Effect.forEach(socket.sent, (text) => decodeViewerDown(text))

const deltaEvents = (socket: { readonly sent: ReadonlyArray<string> }) =>
  Effect.map(received(socket), (messages) =>
    messages.flatMap((message) =>
      message._tag === "Delta" ? (message.orderFlowEvents ?? []) : []
    )
  )

const named = (events: ReadonlyArray<OrderFlowEvent>) =>
  events.map((event) => [
    event.kind,
    event.code,
    event.side,
    event.price,
    DateTime.formatIso(DateTime.add(event.at, { hours: 7 })).slice(11, 16),
  ])

const EXHAUSTION = [["exhaustion", "UNTR", "buy", 1250, "09:45"]]

const recordedEvents = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({ _tag: "OrderFlowEvents", code: UNTR })
  return {
    cacheControl: response.headers.get("Cache-Control"),
    answer: yield* decodeRecordedOrderFlowEvents(
      yield* Effect.promise(() => response.text())
    ),
  }
})

describe("order flow events", () => {
  it.effect(
    "an Exhaustion goes out in the delta 5 s past its minute and comes back in snapshots",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const day = yield* tradingDay()
        const page = yield* day.viewer("BBCA")
        yield* push(day)
        yield* at("09:46:00.000")
        yield* day.trades([trade("09:46:00", "BBCA", 1000, 1)])
        yield* at("09:46:04.000")
        yield* TestClock.adjust("900 millis")
        assert.deepStrictEqual(yield* deltaEvents(page), [])
        yield* TestClock.adjust("1100 millis")
        assert.deepStrictEqual(named(yield* deltaEvents(page)), EXHAUSTION)
        assert.deepInclude((yield* deltaEvents(page))[0], {
          lots: 900,
          peakLots: 2400,
          ticks: 1,
          widestTicks: 5,
        })

        const untr = yield* day.viewer("UNTR")
        const [snapshot] = yield* received(untr)
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(
          named(snapshot.orderFlowEvents ?? []),
          EXHAUSTION
        )
        assert.deepStrictEqual(
          named(snapshot.selectedOrderFlowEvents ?? []),
          EXHAUSTION
        )
        const bbca = yield* day.viewer("BBCA")
        const [other] = yield* received(bbca)
        assert(other?._tag === "Snapshot")
        assert.strictEqual(other.selectedOrderFlowEvents, undefined)
        for (const socket of [page, untr, bbca]) yield* day.left(socket)
      })
  )

  it.effect("the GET's path reads back as its resource", () =>
    Effect.gen(function* () {
      const resource = { _tag: "OrderFlowEvents" as const, code: UNTR }
      const path = yield* recordedDayPath(WibDate.make("2026-11-09"), resource)
      assert.strictEqual(
        path,
        "/market-live/days/2026-11-09/order-flow-events/UNTR"
      )
      const read = yield* recordedDayRequest(
        new URL(path, "https://kumora.test")
      )
      assert.deepStrictEqual(
        read,
        Option.some({ date: WibDate.make("2026-11-09"), resource })
      )
    })
  )

  it.effect(
    "an event is stored by the flush and comes back through the GET, live and sealed",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const day = yield* tradingDay()
        yield* pushJudged(day)
        const live = yield* recordedEvents(day)
        assert.strictEqual(live.cacheControl, "no-store")
        assert.deepStrictEqual(named(live.answer.events), EXHAUSTION)
        assert.isTrue(live.answer.recorded)
        yield* at("17:00:00.000")
        yield* day.alarm
        const sealed = yield* recordedEvents(day)
        assert.strictEqual(sealed.cacheControl, SEALED_CACHE)
        assert.deepStrictEqual(named(sealed.answer.events), EXHAUSTION)
        assert.isTrue(sealed.answer.recorded)
      })
  )

  it.effect(
    "a day sealed before order flow events answers none, marked not recorded",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("09:38:59.000")
        const day = yield* tradingDay(sql)
        yield* pushJudged(day)
        yield* at("17:00:00.000")
        yield* day.alarm
        yield* day.evicted
        sql.exec("DELETE FROM facts WHERE key = 'order-flow-events'")
        sql.exec("DELETE FROM order_flow_events")
        yield* TestClock.setTime(Date.parse("2026-11-10T10:00:00+07:00"))
        const older = yield* recordedEvents(yield* tradingDay(sql))
        assert.deepStrictEqual(older.answer, {
          code: UNTR,
          recorded: false,
          events: [],
        })
      })
  )

  it.effect(
    "a restarted object still answers the day's stored events, once each",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* pushJudged(day)
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const untr = yield* restarted.viewer("UNTR")
        const [snapshot] = yield* received(untr)
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(
          named(snapshot.orderFlowEvents ?? []),
          EXHAUSTION
        )
        assert.deepStrictEqual(
          named(snapshot.selectedOrderFlowEvents ?? []),
          EXHAUSTION
        )
        yield* restarted.left(untr)
        assert.deepStrictEqual(
          named((yield* recordedEvents(restarted)).answer.events),
          EXHAUSTION
        )
      })
  )

  it.effect(
    "an object restarted mid-push still finds the Exhaustion from the stored minutes",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* push(day, PUSH.slice(0, 6))
        yield* at("09:45:00.000")
        yield* day.trades([trade("09:45:00", "BBCA", 1000, 1)])
        // 09:44 flushed 5 s past its close.
        yield* at("09:45:06.000")
        yield* TestClock.adjust("1 second")
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("BBCA")
        // 09:45's 900 lots at 1240 and 1245, then BBCA on to 09:46:00.
        for (const second of [10, 20, 30, 40, 50]) {
          const time = `09:45:${second}`
          yield* at(`${time}.000`)
          yield* restarted.trades([
            ...(second === 20 ? [trade(time, "UNTR", 1240, 450)] : []),
            ...(second === 30 ? [trade(time, "UNTR", 1245, 450)] : []),
            trade(time, "BBCA", 1000, 1),
          ])
          yield* TestClock.adjust("300 millis")
        }
        yield* at("09:46:00.000")
        yield* restarted.trades([trade("09:46:00", "BBCA", 1000, 1)])
        yield* at("09:46:06.000")
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(named(yield* deltaEvents(page)), EXHAUSTION)
        assert.deepInclude((yield* deltaEvents(page))[0], {
          lots: 900,
          peakLots: 2400,
          widestTicks: 5,
        })
        yield* restarted.left(page)
      })
  )

  it.effect(
    "an object restarted after the day's high finds no Exhaustion below it",
    () =>
      Effect.gen(function* () {
        yield* at("09:19:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* push(day, [["09:20", 1300, 1300, 200]])
        yield* at("09:21:06.000")
        yield* TestClock.adjust("1 second")
        yield* day.evicted
        yield* at("09:38:59.000")
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("BBCA")
        yield* push(restarted)
        yield* at("09:46:00.000")
        yield* restarted.trades([trade("09:46:00", "BBCA", 1000, 1)])
        yield* at("09:46:06.000")
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* deltaEvents(page), [])
        yield* restarted.left(page)
      })
  )

  it.effect(
    "an event found but not flushed before a restart is found again, stored, and not sent again",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        const before = yield* day.viewer("BBCA")
        yield* push(day)
        yield* at("09:46:00.000")
        yield* day.trades([trade("09:46:00", "BBCA", 1000, 1)])
        yield* at("09:46:06.000")
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(named(yield* deltaEvents(before)), EXHAUSTION)
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("UNTR")
        for (const second of [10, 20, 30, 40, 50, 60]) {
          const time = second === 60 ? "09:47:00" : `09:46:${String(second)}`
          yield* at(`${time}.000`)
          yield* restarted.trades([trade(time, "BBCA", 1000, 1)])
          yield* TestClock.adjust("300 millis")
        }
        yield* at("09:47:06.000")
        yield* TestClock.adjust("1 second")
        const [snapshot] = yield* received(page)
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(
          named(snapshot.selectedOrderFlowEvents ?? []),
          EXHAUSTION
        )
        assert.deepStrictEqual(yield* deltaEvents(page), [])
        yield* restarted.left(page)
        yield* restarted.evicted
        assert.deepStrictEqual(
          named((yield* recordedEvents(yield* tradingDay(sql))).answer.events),
          EXHAUSTION
        )
      })
  )

  it.effect(
    "a stored event a late trade undid before a restart is not sent again when another late trade redoes it",
    () =>
      Effect.gen(function* () {
        yield* at("09:38:59.000")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* pushJudged(day)
        // BBCA every 10 s from `from` through `to` (HH:MM:SS, on the 10 s),
        // with `late` among the first.
        const tick = (
          on: Day,
          from: string,
          to: string,
          late: ReadonlyArray<ReturnType<typeof trade>> = []
        ) =>
          Effect.gen(function* () {
            for (
              let time = Date.parse(`2026-11-09T${from}+07:00`), first = true;
              time <= Date.parse(`2026-11-09T${to}+07:00`);
              time += 10_000, first = false
            ) {
              const clock = new Date(time + 7 * 3600_000)
                .toISOString()
                .slice(11, 19)
              yield* at(`${clock}.000`)
              yield* on.trades([
                ...(first ? late : []),
                trade(clock, "BBCA", 1000, 1),
              ])
              yield* TestClock.adjust("300 millis")
            }
          })
        // 09:45's buy-aggressor lots rise to 1,300, over half the push's
        // 2,400: the Exhaustion no longer holds. Flushed by 09:48:06.
        yield* tick(day, "09:47:10", "09:48:00", [
          trade("09:45:40", "UNTR", 1240, 400),
        ])
        yield* at("09:48:06.000")
        yield* TestClock.adjust("1 second")
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("BBCA")
        // 09:42 rises to 2,800 lots: 09:45's 1,300 is under half again.
        yield* tick(restarted, "09:48:10", "09:49:00", [
          trade("09:42:40", "UNTR", 1240, 400),
        ])
        yield* at("09:49:06.000")
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* deltaEvents(page), [])
        yield* restarted.left(page)
      })
  )
})
