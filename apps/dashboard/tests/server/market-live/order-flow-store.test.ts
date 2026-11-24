// Order flow events through the day store: each kind's figures, DateTimes
// included, read back as they were written (spec apinrdw/kumora#605,
// "Order flow events: data").
import { assert, describe, it } from "@effect/vitest"
import { StockCode, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeDayStore } from "@/server/market-live/day-store"

import { memorySql } from "./sql"

const BBCA = StockCode.make("BBCA")
const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)

const EVENTS: ReadonlyArray<OrderFlowEvent> = [
  {
    kind: "exhaustion",
    code: BBCA,
    at: wib("09:45:00"),
    side: "buy",
    price: 1250,
    lots: 900,
    peakLots: 2400,
    ticks: 2,
    widestTicks: 6,
  },
  {
    kind: "divergence",
    code: BBCA,
    at: wib("10:58:00"),
    side: "buy",
    price: 1255,
    delta: 8100,
    earlierAt: wib("10:42:00"),
    earlierPrice: 1245,
    earlierDelta: 12_400,
  },
  {
    kind: "failedBreak",
    code: BBCA,
    at: wib("11:10:00"),
    side: "sell",
    price: 1230,
    to: 1220,
    value: 420_000_000,
    close: 1235,
    minutes: 2,
  },
]

describe("the day store's order flow events", () => {
  it.effect("each kind reads back as it was flushed", () =>
    Effect.gen(function* () {
      const store = yield* makeDayStore(memorySql())
      yield* store.write({
        trades: [],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
        candles: [],
        orderFlowEvents: EVENTS,
      })
      const read = yield* store.orderFlowEventsOf(BBCA)
      assert.deepStrictEqual(
        read.map((event) => ({
          ...event,
          at: DateTime.toEpochMillis(event.at),
          ...(event.kind === "divergence"
            ? { earlierAt: DateTime.toEpochMillis(event.earlierAt) }
            : {}),
        })),
        EVENTS.map((event) => ({
          ...event,
          at: DateTime.toEpochMillis(event.at),
          ...(event.kind === "divergence"
            ? { earlierAt: DateTime.toEpochMillis(event.earlierAt) }
            : {}),
        }))
      )
    })
  )
})
