// order-flow.test.ts's push example through the trading-day object: one
// code's minutes 09:39–09:45 that end in a buying Exhaustion at 1250 on
// 09:45, with a 1-lot BBCA trade every 10 s so no relay gap opens.
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, type tradingDay } from "./day-harness"

type Day = Effect.Success<ReturnType<typeof tradingDay>>

export const at = (time: string) =>
  TestClock.setTime(Date.parse(`2026-11-09T${time}+07:00`))

const PUSH: ReadonlyArray<readonly [string, number, number, number]> = [
  ["09:39", 1200, 1200, 200],
  ["09:40", 1200, 1215, 1000],
  ["09:41", 1215, 1230, 1500],
  ["09:42", 1225, 1250, 2400],
  ["09:43", 1235, 1245, 1250],
  ["09:44", 1240, 1245, 1300],
  ["09:45", 1240, 1245, 900],
]

// Trade numbers well past any a test sends before the push.
let number = 1_000
export const trade = (
  time: string,
  code: string,
  price: number,
  lots: number
) =>
  stockbitTrade({
    number: number++,
    time,
    code,
    price,
    lots,
    side: "buy",
  })

// Each minute's two `code` trades at :00 and :10, and BBCA's every 10 s,
// of `minutes`.
export const push = (day: Day, minutes = PUSH, code = "UNTR") =>
  Effect.gen(function* () {
    for (const [minute, first, second, lots] of minutes)
      for (const second10 of [0, 10, 20, 30, 40, 50]) {
        const time = `${minute}:${String(second10).padStart(2, "0")}`
        yield* at(`${time}.000`)
        const half = Math.floor(lots / 2)
        yield* day.trades([
          ...(second10 === 0 ? [trade(time, code, first, half)] : []),
          ...(second10 === 10 ? [trade(time, code, second, lots - half)] : []),
          trade(time, "BBCA", 1000, 1),
        ])
        yield* TestClock.adjust("300 millis")
      }
  })

// The push through 09:45, judged 5 s past 09:45's close in a delta to a
// viewer, who then leaves; flushed by 09:47.
export const pushJudged = (day: Day, code = "UNTR") =>
  Effect.gen(function* () {
    const page = yield* day.viewer("BBCA")
    yield* push(day, PUSH, code)
    yield* at("09:46:00.000")
    yield* day.trades([trade("09:46:00", "BBCA", 1000, 1)])
    yield* at("09:46:06.000")
    yield* TestClock.adjust("1 second")
    yield* day.left(page)
    yield* at("09:47:06.000")
    yield* TestClock.adjust("1 second")
  })
