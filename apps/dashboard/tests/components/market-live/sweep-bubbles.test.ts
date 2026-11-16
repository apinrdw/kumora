import {
  BrokerCode,
  TradeNumber,
  type Sweep,
  type SweepPiece,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { bubblesOf } from "@/components/market-live/sweep-bubbles"
import { keptSweeps, splitSweeps } from "@/lib/sweeps"

const sell = (
  firstTrade: string,
  time: string,
  lots: number,
  price: number
): Sweep => ({
  side: "sell",
  firstTrade: TradeNumber.make(firstTrade),
  time: DateTime.makeUnsafe(`2026-11-09T${time}+07:00`),
  first: price,
  last: price,
  lots,
  value: price * lots * 100,
  trades: 1,
})

const piece = (sweep: Sweep, aggressor: string): SweepPiece => ({
  ...sweep,
  aggressor: [
    { code: BrokerCode.make(aggressor), investorType: "D", lots: sweep.lots },
  ],
  other: [],
})

describe("chart 1's bubbles", () => {
  it.effect(
    "draw one bubble per piece at its own average price, largest first within its second",
    () =>
      Effect.gen(function* () {
        // 1's sell of FZ 4, XL 10 and AZ 6 lots in 09:00:20, and 9's in
        // 09:00:40.
        const whole = sell("1", "09:00:20.100", 20, 1_000)
        const later = sell("9", "09:00:40.000", 2, 990)
        const split = yield* splitSweeps(
          [whole, later],
          new Map([
            [
              whole.firstTrade,
              {
                firstTrade: whole.firstTrade,
                pieces: [
                  piece(sell("1", "09:00:20.100", 4, 1_000), "FZ"),
                  piece(sell("2", "09:00:20.200", 10, 995), "XL"),
                  piece(sell("3", "09:00:20.300", 6, 990), "AZ"),
                ],
              },
            ],
          ])
        )
        const byMinute = yield* bubblesOf(
          yield* keptSweeps(split.sweeps, split.pieces, undefined)
        )
        expect(
          [...byMinute.values()]
            .flat()
            .map((bubble) => [bubble.id, bubble.lots, bubble.price])
        ).toEqual([
          ["2", 10, 995],
          ["3", 6, 990],
          ["1", 4, 1_000],
          ["9", 2, 990],
        ])
      })
  )
})
