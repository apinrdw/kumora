// Order flow events through the trading-day object (spec apinrdw/kumora#605,
// "Order flow events: data"): Stockbit trades go in through the ingest
// socket, time moves only by TestClock, and the test reads what viewers
// receive. The minutes are order-flow.test.ts's push example on UNTR, with a
// 1-lot BBCA trade every 10 s so no relay gap opens.
import { assert, describe, it } from "@effect/vitest"
import { decodeViewerDown, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, tradingDay } from "./day-harness"

const at = (time: string) =>
  TestClock.setTime(Date.parse(`2026-11-09T${time}+07:00`))

type Day = Effect.Success<ReturnType<typeof tradingDay>>

const PUSH: ReadonlyArray<readonly [string, number, number, number]> = [
  ["09:39", 1200, 1200, 200],
  ["09:40", 1200, 1215, 1000],
  ["09:41", 1215, 1230, 1500],
  ["09:42", 1225, 1250, 2400],
  ["09:43", 1235, 1245, 1250],
  ["09:44", 1240, 1245, 1300],
  ["09:45", 1240, 1245, 900],
]

let number = 1
const trade = (time: string, code: string, price: number, lots: number) =>
  stockbitTrade({
    number: number++,
    time,
    code,
    price,
    lots,
    side: "buy",
  })

// Each minute's two UNTR trades at :00 and :10, and BBCA's every 10 s.
const push = (day: Day) =>
  Effect.gen(function* () {
    for (const [minute, first, second, lots] of PUSH)
      for (const second10 of [0, 10, 20, 30, 40, 50]) {
        const time = `${minute}:${String(second10).padStart(2, "0")}`
        yield* at(`${time}.000`)
        const half = Math.floor(lots / 2)
        yield* day.trades([
          ...(second10 === 0 ? [trade(time, "UNTR", first, half)] : []),
          ...(second10 === 10
            ? [trade(time, "UNTR", second, lots - half)]
            : []),
          trade(time, "BBCA", 1000, 1),
        ])
        yield* TestClock.adjust("300 millis")
      }
  })

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
})
