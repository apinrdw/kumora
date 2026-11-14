// Both Market Live charts' price axis on IDX ticks (spec apinrdw/kumora#263,
// "Both charts", "IDX tick axis", and "Chart 2", "Rows"), apart from
// Lightweight Charts: price-axis.ts in the components draws what these work
// out.
import { Effect } from "effect"

import { idxTick } from "./footprint"
import { price } from "./format"

// The valid price nearest `value`, on the tick of its own band.
export const snapToTick = Effect.fnUntraced(function* (value: number) {
  const tick = yield* idxTick(value)
  return Math.round(value / tick) * tick
})

// A price as the axis and the crosshair write it: snapped, with commas.
export const priceLabel = Effect.fnUntraced(function* (value: number) {
  return yield* price(yield* snapToTick(value))
})

// Decision: a label (and its gridline) needs 13 px of its own, so the axis
// labels every tick from rows 13 px tall and every 2nd, 4th, 8th… below.
const LABEL_PX = 13

// The prices the axis labels between `bottom` and `top`, ascending, with
// rows (one tick) `rowPx` tall: every tick of the middle's band, thinned
// until labels are 13 px apart.
export const labelPrices = Effect.fnUntraced(function* ({
  bottom,
  top,
  rowPx,
}: {
  readonly bottom: number
  readonly top: number
  readonly rowPx: number
}) {
  const tick = yield* idxTick((top + bottom) / 2)
  let step = tick
  while (rowPx > 0 && (rowPx * step) / tick < LABEL_PX) step *= 2
  const prices: Array<number> = []
  for (let at = Math.ceil(bottom / step) * step; at <= top; at += step)
    prices.push(at)
  return prices
})

// Decision: chart 2's rows are at most 36 px a tick, so a quiet window's few
// prices don't stretch into giant cells (spec apinrdw/kumora#263, "Rows").
const ROW_PX = 36
// The footprint's scale margins leave this share of the pane for prices.
const PLOT_SHARE = 0.88

// Chart 2's price range for the visible minutes' `minValue` to `maxValue`:
// widened around its middle until one tick is at most 36 px of a pane
// `paneHeight` tall. A wider range is kept, its rows shrinking to fit.
export const rowCappedRange = Effect.fnUntraced(function* ({
  minValue,
  maxValue,
  paneHeight,
}: {
  readonly minValue: number
  readonly maxValue: number
  readonly paneHeight: number
}) {
  const middle = (minValue + maxValue) / 2
  const tick = yield* idxTick(middle)
  const half = Math.max(
    (maxValue - minValue) / 2 + tick / 2,
    ((paneHeight * PLOT_SHARE) / ROW_PX) * (tick / 2)
  )
  return { minValue: middle - half, maxValue: middle + half }
})
