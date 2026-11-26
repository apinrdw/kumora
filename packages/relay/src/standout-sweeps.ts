// The day's standout sweeps as a list both ends keep: the trading-day object
// as its snapshot backlog, the live page as its All codes rows. See spec
// apinrdw/kumora#705.
import { DateTime, Effect, Order } from "effect"

import type { StandoutLevel, StandoutSweep } from "./envelope.ts"
import { STANDOUT_LEVELS, TradeNumberOrder } from "./envelope.ts"

// The rows each picker level shows at most: the newest of the standout
// sweeps at or under it. At 10% a busy day across ~900 codes can decide tens
// of thousands, and the 10% rows would crowd the rarer 1% ones out of a list
// capped as one. A list kept this way holds at most 3 × 500 rows, ~90 bytes
// each encoded: a snapshot carries ~135 KB of them at most.
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

// `held` with `arriving` joined, newest first, each sweep once by
// `standoutKey` (the one in `held` kept), and only the rows among the newest
// STANDOUTS_PER_LEVEL at or under their own level: every level's list holds
// its newest STANDOUTS_PER_LEVEL. `held` is a list this returned.
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
  const seen = new Map<StandoutLevel, number>(
    STANDOUT_LEVELS.map((level) => [level, 0])
  )
  return [...fresh, ...held].sort(NewestFirst).filter((row) => {
    const kept = seen.get(row.level)! < STANDOUTS_PER_LEVEL
    for (const level of STANDOUT_LEVELS)
      if (level >= row.level) seen.set(level, seen.get(level)! + 1)
    return kept
  })
})
