import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { heatSlices } from "@/lib/heatmap"

const MINUTE = Date.parse("2026-11-09T14:20:00+07:00")
const at = (seconds: number) => MINUTE + seconds * 1_000

const book = (
  bids: ReadonlyArray<readonly [number, number]>,
  offers: ReadonlyArray<readonly [number, number]>
) => ({
  bids: bids.map(([price, lots]) => ({ price, lots, orders: 1 })),
  offers: offers.map(([price, lots]) => ({ price, lots, orders: 1 })),
})

// A slice as a test compares it: seconds into the minute, then its levels.
const shown = (
  slices: ReadonlyArray<{
    readonly at: DateTime.Utc
    readonly levels: ReadonlyArray<readonly [number, number, number]>
  }>
) =>
  slices.map((slice) => [
    (DateTime.toEpochMillis(slice.at) - MINUTE) / 1_000,
    slice.levels,
  ])

describe("the book heatmap's 10-second slices", () => {
  it.effect(
    "average each price's resting lots over the time each book was in force",
    () =>
      Effect.gen(function* () {
        const slices = yield* heatSlices(
          [
            // Served 4 s into the first slice: it rested 6 of its 10 s.
            { at: at(4), book: book([[8_000, 50]], [[8_025, 40]]) },
            // The bid grows 5 s into the second slice; the offer walks up.
            {
              at: at(15),
              book: book(
                [[8_000, 90]],
                [
                  [8_025, 20],
                  [8_050, 10],
                ]
              ),
            },
          ],
          MINUTE,
          MINUTE + 30_000
        )
        expect(shown(slices)).toEqual([
          [
            0,
            [
              [8_000, 30, 0],
              [8_025, 0, 24],
            ],
          ],
          [
            10,
            [
              [8_000, 70, 0],
              [8_025, 0, 30],
              [8_050, 0, 5],
            ],
          ],
          [
            20,
            [
              [8_000, 90, 0],
              [8_025, 0, 20],
              [8_050, 0, 10],
            ],
          ],
        ])
      })
  )

  it.effect(
    "start from the book in force before them, and leave out slices with no book",
    () =>
      Effect.gen(function* () {
        const before = { at: at(-30), book: book([[8_000, 12]], []) }
        expect(
          shown(yield* heatSlices([before], MINUTE, MINUTE + 20_000))
        ).toEqual([
          [0, [[8_000, 12, 0]]],
          [10, [[8_000, 12, 0]]],
        ])
        // No book until 25 s: the first two slices have none.
        expect(
          shown(
            yield* heatSlices(
              [{ at: at(25), book: book([], [[8_025, 8]]) }],
              MINUTE,
              MINUTE + 30_000
            )
          )
        ).toEqual([[20, [[8_025, 0, 4]]]])
      })
  )

  it.effect("round each average to whole lots and drop prices left at 0", () =>
    Effect.gen(function* () {
      const slices = yield* heatSlices(
        [
          { at: at(0), book: book([[8_000, 3]], []) },
          // 1 lot for 1 s averages 0.1: it rounds away.
          {
            at: at(1),
            book: book(
              [
                [8_000, 3],
                [7_975, 1],
              ],
              []
            ),
          },
          { at: at(2), book: book([[8_000, 3]], []) },
        ],
        MINUTE,
        MINUTE + 10_000
      )
      expect(shown(slices)).toEqual([[0, [[8_000, 3, 0]]]])
    })
  )
})
