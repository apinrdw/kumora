// How Market Live's two charts move together (spec apinrdw/kumora#263,
// "Chart 2", "Own zoom" and "Pan sync"), apart from Lightweight Charts: the
// minutes both draw, the footprint chart's 10-minute window and what counts as
// a pan.
import type { RelayGap } from "@workspace/relay"
import { Effect } from "effect"

import { gapMinutes } from "./replay"

// A visible logical range, in bar indices.
export interface BarRange {
  readonly from: number
  readonly to: number
}

// The visible logical range that shows `count` whole bars around `middle`.
// Lightweight Charts 5.2.1 draws bars a…b of a range from a to b, both ends
// included, so `count` bars span a range `count - 1` wide.
export const windowAround = (middle: number, count: number) =>
  Effect.sync((): BarRange => {
    const from = Math.round(middle) - Math.floor((count - 1) / 2)
    return { from, to: from + count - 1 }
  })

// How many bars a range change moved, when it is a pan: the width kept and
// the range moved. A zoom (the width changed) or no move is no pan.
export const panShift = (previous: BarRange, next: BarRange) =>
  Effect.sync(() => {
    const widened = next.to - next.from - (previous.to - previous.from)
    const shift = next.from - previous.from
    return Math.abs(widened) > 0.01 || Math.abs(shift) < 1e-6
      ? undefined
      : shift
  })

// The minutes a chart draws, epoch ms: its candles' and, as whitespace, each
// relay gap's minutes that have no candle (`runs`, to shade). A gap with no
// end runs to `end`.
// Both charts draw exactly these minutes, so a logical index is the
// same minute on each and a pan moves both by the same minutes.
export const chartMinutes = Effect.fnUntraced(function* (
  candleMinutes: ReadonlyArray<number>,
  gaps: ReadonlyArray<RelayGap>,
  end: number
) {
  const candles = new Set(candleMinutes)
  const runs = (yield* gapMinutes(gaps, end))
    .map((run) => run.filter((minute) => !candles.has(minute)))
    .filter((run) => run.length > 0)
  const blank = runs.flat()
  return {
    runs,
    blank,
    all: [...candleMinutes, ...blank].sort((a, b) => a - b),
  }
})
