// IDX tick sizes and auto-reject price limits (spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes"), as constants. The research behind
// them is docs/research/idx-board-ticks-limits.md.
import { Effect } from "effect"

import type { WibDate } from "./schedule.ts"

// The tick table is Peraturan II-A VI.5.2 as amended by
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

// The tick at `price`: the step to the next price up.
export const tickAt = (price: number) =>
  Effect.sync(() => {
    let tick = 1
    for (const band of TICK_BANDS) if (price >= band.from) tick = band.tick
    return tick
  })

// The ticks from `low` up to `high`, each step on the tick of the price it
// leaves. Prices off the grid count to the nearest whole tick.
export const ticksBetween = (low: number, high: number) =>
  Effect.sync(() => {
    let ticks = 0
    TICK_BANDS.forEach((band, index) => {
      const to = TICK_BANDS[index + 1]?.from ?? Number.POSITIVE_INFINITY
      const span = Math.min(high, to) - Math.max(low, band.from)
      if (span > 0) ticks += span / band.tick
    })
    return Math.round(ticks)
  })

// Which limit rule a code trades under: a share's on the regular boards
// (II-A), the Special Monitoring Board's (II-X), a warrant's or a right's.
type LimitRule = "regular" | "special" | "warrant" | "right"

// One band of reference prices, up to and including `through`, and its
// limits in percent; `undefined` is a Rp1 move.
interface LimitBand {
  readonly through: number
  readonly up: number | undefined
  readonly down: number | undefined
}

// From 2027-01-01 the permanent II-A VI.7.1.1 table (±35/25/20%) applies; a
// new Kep extending the transition needs a change here. Days before
// 2026-10-20 use the transition too: the limits only flag a code at its limit.
// The regular boards' limits are Kep-00158/BEI/10-2026 (in force
// 2026-10-20): the lower limit is 7% from Rp15 and Rp1 below it until
// 2026-12-31. See spec apinrdw/kumora#517, "Ticks, limits and excluded codes".
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
// A Special Monitoring Board code's limits are Peraturan II-X
// II.1.5 (Kep-00140/BEI/09-2026, in force 2026-09-28, no end date): ±Rp1 to
// Rp10 and ±10% above. The 7% transition doesn't touch it.
const SPECIAL: ReadonlyArray<LimitBand> = [
  { through: 10, up: undefined, down: undefined },
  { through: Number.POSITIVE_INFINITY, up: 10, down: 10 },
]
// A warrant's limits are II-A VI.7.1.3, ±50% to Rp200, ±40% to
// Rp5,000 and ±30% above, both ways and with no transition; the research
// gives 50% from Rp10, read here as from Rp1. A right (HMETD) has none but
// the Rp1 floor (VI.7.4). See docs/research/idx-board-ticks-limits.md,
// "Warrants and others".
const WARRANT: ReadonlyArray<LimitBand> = [
  { through: 200, up: 50, down: 50 },
  { through: 5_000, up: 40, down: 40 },
  { through: Number.POSITIVE_INFINITY, up: 30, down: 30 },
]

// The lowest price an order may carry (II-A VI.6).
const MINIMUM_PRICE = 1

// Rounds to a whole rupiah first: `reference × percent ÷ 100` of whole
// numbers is exact only when it is whole.
const settled = (price: number) => Effect.succeed(Math.round(price * 1e6) / 1e6)

// A percentage limit lands on the valid tick toward the reference
// (the upper limit rounds down, the lower up). II-A gives percentages, not how
// JATS rounds them; this reading is inferred (docs/research/
// idx-board-ticks-limits.md, "Open risks").
const floorToTick = Effect.fnUntraced(function* (price: number) {
  const tick = yield* tickAt(price)
  return Math.floor((yield* settled(price)) / tick) * tick
})
const ceilToTick = Effect.fnUntraced(function* (price: number) {
  const exact = yield* settled(price)
  const tick = yield* tickAt(exact)
  return Math.ceil(exact / tick) * tick
})

const bandsOf = (rule: Exclude<LimitRule, "right">, date: WibDate) => {
  if (rule === "special") return SPECIAL
  if (rule === "warrant") return WARRANT
  return date <= TRANSITION_ENDS ? TRANSITION : PERMANENT
}

// The upper and lower auto-reject limits of a code whose reference price
// (its previous close) is `reference`, on `date`, under `rule`; a right's
// upper limit is none, as infinity.
export const priceLimitsOf = Effect.fnUntraced(function* (
  reference: number,
  date: WibDate,
  rule: LimitRule
) {
  if (rule === "right")
    return { upper: Number.POSITIVE_INFINITY, lower: MINIMUM_PRICE }
  const bands = bandsOf(rule, date)
  const band = bands.find((each) => reference <= each.through)!
  return {
    upper:
      band.up === undefined
        ? reference + 1
        : yield* floorToTick((reference * (100 + band.up)) / 100),
    lower: Math.max(
      MINIMUM_PRICE,
      band.down === undefined
        ? reference - 1
        : yield* ceilToTick((reference * (100 - band.down)) / 100)
    ),
  }
})
