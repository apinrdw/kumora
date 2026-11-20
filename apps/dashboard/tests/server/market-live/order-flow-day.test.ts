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
import { at, push, pushJudged, trade } from "./order-flow-push"
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
})
