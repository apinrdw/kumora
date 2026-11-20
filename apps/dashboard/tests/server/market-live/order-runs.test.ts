// Order-run pieces (spec apinrdw/kumora#627, "Slice 2", ticket
// apinrdw/kumora#629): trades go in through the ingest socket, the day
// seals, broker codes batches carry order numbers, and the test reads the
// sweep brokers GET.
import { assert, describe, it } from "@effect/vitest"
import type { OrderNumbers, SweepBrokers } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, tradingDay } from "./day-harness"

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

// A sealed day holding UNTR's sell sweep of trades 1.. at 09:00:10, each
// trade's lots in turn.
const sealedSellSweep = Effect.fnUntraced(function* (
  lots: ReadonlyArray<number>
) {
  yield* at("09:01:10")
  const day = yield* tradingDay()
  yield* day.trades(
    lots.map((each, index) =>
      stockbitTrade({
        number: index + 1,
        time: `09:00:10.${String(100 + index).padStart(3, "0")}`,
        price: 23300,
        lots: each,
        side: "sell",
      })
    )
  )
  yield* at("17:00:00")
  yield* day.alarm
  yield* at("17:30:00")
  return day
})

// Each piece as the test compares it: first trade, aggressor `code lots`,
// and its orders as `count first-last passive lots`, or none.
const piecesOf = (sweep: SweepBrokers) =>
  sweep.pieces.map((piece) => [
    Number(piece.firstTrade),
    piece.aggressor.map((b) => `${b.code} ${b.lots}`).join(),
    piece.orders === undefined
      ? "none"
      : `${piece.orders.count} ${piece.orders.first}-${piece.orders.last} ${piece.orders.biggestPassiveLots}`,
  ])

// A row selling from `seller`'s order `sell` to KZ's order `buy`.
const sold = (
  number: number,
  seller: string,
  [buy, sell]: OrderNumbers
): readonly [number, string, null, OrderNumbers] => [
  number,
  `KZ D ${seller} D`,
  null,
  [buy, sell],
]

describe("a whole sweep every one of whose trades has order numbers", () => {
  it.effect(
    "joins one broker's orders stepping by at most 3 into one piece, another broker's order between them included",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedSellSweep([2, 3, 4, 5])
        yield* day.brokerCodes(
          "Ajaib",
          [
            sold(1, "AK", [900, 1001]),
            sold(2, "CC", [900, 1002]),
            sold(3, "AK", [900, 1004]),
            sold(4, "AK", [950, 1007]),
          ],
          4
        )
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        // KZ's order 900 took 2 + 4 lots of AK's run, order 950 took 5.
        assert.deepStrictEqual(answer.sweeps.flatMap(piecesOf), [
          [1, "AK 11", "3 1001-1007 6"],
          [2, "CC 3", "1 1002-1002 3"],
        ])
      })
  )
})
