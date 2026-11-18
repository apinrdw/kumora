// IDX tick sizes and auto-reject price limits (spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes"), as constants. The research behind
// them is docs/research/idx-board-ticks-limits.md.
import { Effect } from "effect"

import type { WibDate } from "./schedule.ts"

// Decision: the tick table is Peraturan II-A VI.5.2 as amended by
// Kep-00158/BEI/10-2026, in force from 2026-10-20 with no end date. VI.5.4
// makes the tick follow each order's own price, so one book straddling a band
// edge uses two ticks, and a spread or gap across it counts each price on its
// own. Each band runs from its `from` to the next band's.
const TICK_BANDS: ReadonlyArray<{
  readonly from: number
  readonly tick: number
}> = [
  { from: 0, tick: 1 },
  { from: 200, tick: 2 },
  { from: 500, tick: 5 },
  { from: 2_000, tick: 10 },
  { from: 5_000, tick: 25 },
]

const plainTickAt = (price: number) => {
  let tick = 1
  for (const band of TICK_BANDS) if (price >= band.from) tick = band.tick
  return tick
}

// The tick at `price`: the step to the next price up.
export const tickAt = (price: number) => Effect.sync(() => plainTickAt(price))

// The ticks from `low` up to `high`, each step on the tick of the price it
// leaves. Prices off the grid count to the nearest whole tick.
const plainTicksBetween = (low: number, high: number) => {
  let ticks = 0
  TICK_BANDS.forEach((band, index) => {
    const to = TICK_BANDS[index + 1]?.from ?? Number.POSITIVE_INFINITY
    const span = Math.min(high, to) - Math.max(low, band.from)
    if (span > 0) ticks += span / band.tick
  })
  return Math.round(ticks)
}

export const ticksBetween = (low: number, high: number) =>
  Effect.sync(() => plainTicksBetween(low, high))

// Which limit rule a code trades under: the regular boards' (II-A) or the
// Special Monitoring Board's (II-X).
export type LimitBoard = "regular" | "special"

// One band of reference prices, up to and including `through`, and its
// limits in percent; `undefined` is a Rp1 move.
interface LimitBand {
  readonly through: number
  readonly up: number | undefined
  readonly down: number | undefined
}

// Decision: the regular boards' limits are Kep-00158/BEI/10-2026 (points 2
// and 3, in force 2026-10-20), which holds the lower limit at 7% from Rp15
// and Rp1 below it until 2026-12-31. From 2027-01-01 the permanent II-A
// VI.7.1.1 table applies (±35/25/20%) unless IDX extends the transition with
// a new Kep, which needs a change here. Days before 2026-10-20 use the
// transition too: the limits only flag a code at its limit. See spec
// apinrdw/kumora#517, "Ticks, limits and excluded codes".
const TRANSITION_ENDS = "2026-12-31"
const TRANSITION: ReadonlyArray<LimitBand> = [
  { through: 10, up: undefined, down: undefined },
  { through: 14, up: 35, down: undefined },
  { through: 200, up: 35, down: 7 },
  { through: 5_000, up: 25, down: 7 },
  { through: Number.POSITIVE_INFINITY, up: 20, down: 7 },
]
const PERMANENT: ReadonlyArray<LimitBand> = [
  { through: 10, up: undefined, down: undefined },
  { through: 200, up: 35, down: 35 },
  { through: 5_000, up: 25, down: 25 },
  { through: Number.POSITIVE_INFINITY, up: 20, down: 20 },
]
// Decision: a Special Monitoring Board code's limits are Peraturan II-X
// II.1.5 (Kep-00140/BEI/09-2026, in force 2026-09-28, no end date): ±Rp1 to
// Rp10 and ±10% above. The 7% transition doesn't touch it.
const SPECIAL: ReadonlyArray<LimitBand> = [
  { through: 10, up: undefined, down: undefined },
  { through: Number.POSITIVE_INFINITY, up: 10, down: 10 },
]

// The lowest price an order may carry (II-A VI.6).
const MINIMUM_PRICE = 1

// Rounds to a whole rupiah first: `reference × percent ÷ 100` of whole
// numbers is exact only when it is whole.
const settled = (price: number) => Math.round(price * 1e6) / 1e6

// Decision: a percentage limit lands on the valid tick toward the reference
// (the upper limit rounds down, the lower up). II-A gives percentages, not how
// JATS rounds them; this reading is inferred (docs/research/
// idx-board-ticks-limits.md, "Open risks").
const floorToTick = (price: number) => {
  const tick = plainTickAt(price)
  return Math.floor(settled(price) / tick) * tick
}
const ceilToTick = (price: number) => {
  const exact = settled(price)
  const tick = plainTickAt(exact)
  return Math.ceil(exact / tick) * tick
}

// The upper and lower auto-reject limits of a code whose reference price
// (its previous close) is `reference`, on `date`, under `board`'s rule.
export const priceLimitsOf = (
  reference: number,
  date: WibDate,
  board: LimitBoard
) =>
  Effect.sync(() => {
    const bands =
      board === "special"
        ? SPECIAL
        : date <= TRANSITION_ENDS
          ? TRANSITION
          : PERMANENT
    const band = bands.find((each) => reference <= each.through)!
    return {
      upper:
        band.up === undefined
          ? reference + 1
          : floorToTick((reference * (100 + band.up)) / 100),
      lower: Math.max(
        MINIMUM_PRICE,
        band.down === undefined
          ? reference - 1
          : ceilToTick((reference * (100 - band.down)) / 100)
      ),
    }
  })
