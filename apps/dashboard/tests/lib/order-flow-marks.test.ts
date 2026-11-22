// Where the charts mark order flow events (spec apinrdw/kumora#605, "Order
// flow events: on the page"): ▲ above a buying-side event's candle, ▼ below
// a selling-side one's, with the kind's letter, and none a recorded day's
// cursor hasn't reached.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, type Candle, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { orderFlowMarks } from "@/lib/order-flow-marks"
import { minuteEnd } from "@/lib/replay"

const code = StockCode.make("BBCA")
const ms = (time: string) => Date.parse(`2026-11-19T${time}+07:00`)

const candle = (time: string, low: number, high: number): Candle => ({
  code,
  minute: DateTime.makeUnsafe(ms(time)),
  open: low,
  high,
  low,
  close: high,
  volume: 100,
  value: 100 * low,
  buyValue: 0,
  sellValue: 0,
  frequency: 1,
})

const exhaustion = (time: string, price: number): OrderFlowEvent => ({
  kind: "exhaustion",
  code,
  at: DateTime.makeUnsafe(ms(time)),
  side: "buy",
  price,
  lots: 900,
  peakLots: 2400,
  ticks: 1,
  widestTicks: 5,
})

const failedBreak = (time: string, price: number): OrderFlowEvent => ({
  kind: "failedBreak",
  code,
  at: DateTime.makeUnsafe(ms(time)),
  side: "sell",
  price,
  to: price - 10,
  value: 420_000_000,
  close: price + 5,
  minutes: 0,
})

const candles = [
  candle("10:12:00", 1230, 1250),
  candle("10:13:00", 1235, 1255),
  candle("10:30:00", 1200, 1220),
]

describe("order flow marks", () => {
  it.effect(
    "puts a buying-side mark at its candle's high and a selling-side one at its low",
    () =>
      Effect.gen(function* () {
        const marks = yield* orderFlowMarks(
          [exhaustion("10:13:00", 1250), failedBreak("10:30:00", 1205)],
          candles,
          Number.POSITIVE_INFINITY
        )
        assert.deepStrictEqual(
          marks.map(({ minute, above, letter, price }) => ({
            minute,
            above,
            letter,
            price,
          })),
          [
            { minute: ms("10:13:00"), above: true, letter: "E", price: 1255 },
            { minute: ms("10:30:00"), above: false, letter: "F", price: 1200 },
          ]
        )
        assert.strictEqual(
          marks[0]!.key,
          `BBCA|exhaustion|buy|1250|${ms("10:13:00")}`
        )
      })
  )

  it.effect("marks an event in a minute with no candle at its own price", () =>
    Effect.gen(function* () {
      const [mark] = yield* orderFlowMarks(
        [exhaustion("10:20:00", 1240)],
        candles,
        Number.POSITIVE_INFINITY
      )
      assert.strictEqual(mark?.price, 1240)
    })
  )

  it.effect(
    "leaves off an event until the cursor reaches its minute's end, where picking its candle puts it",
    () =>
      Effect.gen(function* () {
        const events = [exhaustion("10:13:00", 1250)]
        assert.lengthOf(
          yield* orderFlowMarks(events, candles, ms("10:13:59")),
          0,
          "inside its minute, the minute hadn't closed"
        )
        assert.lengthOf(
          yield* orderFlowMarks(
            events,
            candles,
            yield* minuteEnd(ms("10:13:00"))
          ),
          1,
          "picking 10:13's candle shows its event"
        )
      })
  )
})
