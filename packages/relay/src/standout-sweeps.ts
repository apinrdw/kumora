// The day's standout sweeps as a list both ends keep: the trading-day object
// as its snapshot backlog, the live page as its All codes rows. See spec
// apinrdw/kumora#705.
import { DateTime, Effect, Order } from "effect"

import type { StandoutLevel, StandoutSweep } from "./envelope.ts"
import { STANDOUT_LEVELS, TradeNumberOrder } from "./envelope.ts"

// Decision: each standout level keeps its newest 500 sweeps
// (packages/relay/docs/adr/0027-each-standout-level-keeps-its-newest-500-sweeps.md)
export const STANDOUTS_PER_LEVEL = 500

// A standout sweep's name for the day: its code and first trade's number.
export const standoutKey = ({ code, sweep }: StandoutSweep) =>
  Effect.succeed(`${code} ${sweep.firstTrade}`)

const NewestFirst = Order.flip(
  Order.combine(
    Order.mapInput(Order.Number, ({ sweep }: StandoutSweep) =>
      DateTime.toEpochMillis(sweep.time)
    ),
    Order.mapInput(
      TradeNumberOrder,
      ({ sweep }: StandoutSweep) => sweep.firstTrade
    )
  )
)

// The rows a list shows at `level`: the newest STANDOUTS_PER_LEVEL of `rows`
// (newest first) at or under it.
export const shownStandouts = (
  rows: ReadonlyArray<StandoutSweep>,
  level: StandoutLevel
) =>
  Effect.succeed(
    rows.filter((row) => row.level <= level).slice(0, STANDOUTS_PER_LEVEL)
  )

// `held` with `arriving` joined, newest first, each sweep once by
// `standoutKey` (the one in `held` kept), and only the rows some level shows
// (`shownStandouts`). `held` is a list this returned.
export const keptStandouts = Effect.fnUntraced(function* (
  held: ReadonlyArray<StandoutSweep>,
  arriving: ReadonlyArray<StandoutSweep>
) {
  if (arriving.length === 0) return held
  const keys = new Set<string>()
  for (const row of held) keys.add(yield* standoutKey(row))
  const fresh: Array<StandoutSweep> = []
  for (const row of arriving) {
    const key = yield* standoutKey(row)
    if (keys.has(key)) continue
    keys.add(key)
    fresh.push(row)
  }
  if (fresh.length === 0) return held
  const joined = [...fresh, ...held].sort(NewestFirst)
  const shown = new Set<StandoutSweep>()
  for (const level of STANDOUT_LEVELS)
    for (const row of yield* shownStandouts(joined, level)) shown.add(row)
  return joined.filter((row) => shown.has(row))
})
