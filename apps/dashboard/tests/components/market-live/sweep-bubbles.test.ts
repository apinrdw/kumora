import {
  BrokerCode,
  TradeNumber,
  type Sweep,
  type SweepPiece,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { SeriesAttachedParameter, Time } from "lightweight-charts"

import { bubblesOf, SweepBubbles } from "@/components/market-live/sweep-bubbles"
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

  it.effect(
    "hover the small piece at a shared centre, and the large one in its ring",
    () =>
      Effect.gen(function* () {
        // 1's sell splits into FZ's 16 lots and XL's 4,096, both at 1,000 in
        // 09:00:20, so their bubbles share a centre.
        const whole = sell("1", "09:00:20.100", 4_112, 1_000)
        const split = yield* splitSweeps(
          [whole],
          new Map([
            [
              whole.firstTrade,
              {
                firstTrade: whole.firstTrade,
                pieces: [
                  piece(sell("1", "09:00:20.100", 16, 1_000), "FZ"),
                  piece(sell("2", "09:00:20.200", 4_096, 1_000), "XL"),
                ],
              },
            ],
          ])
        )
        const byMinute = yield* bubblesOf(
          yield* keptSweeps(split.sweeps, split.pieces, undefined)
        )
        const bubbles = new SweepBubbles(
          { buy: "", sell: "", big: "", selected: "" },
          {} as HTMLElement
        )
        bubbles.attached({
          chart: {
            timeScale: () => ({
              options: () => ({ barSpacing: 6 }),
              timeToCoordinate: () => 100,
            }),
          },
          series: { priceToCoordinate: () => 200 },
          requestUpdate: () => {},
        } as unknown as SeriesAttachedParameter<Time>)
        bubbles.show({
          byMinute,
          threshold: 0,
          at: Number.POSITIVE_INFINITY,
          selected: undefined,
        })
        // 20 s into the minute at a bar spacing of 6 is 2 px past its centre.
        // FZ's bubble has a radius of 1.5 px, XL's 16.
        expect(bubbles.topmost(102, 200)?.id).toBe("1")
        expect(bubbles.topmost(112, 200)?.id).toBe("2")
        expect(bubbles.topmost(122, 200)).toBeUndefined()
      })
  )
})
