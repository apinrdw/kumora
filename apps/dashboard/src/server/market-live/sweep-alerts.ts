// Sweep alerts (spec apinrdw/kumora#510, "Dashboard: the alert rule"): for
// each stock code and aggressor side, the day's sweeps ranked by lots, and a
// sweep that reaches its side's top-1% cutoff among the sweeps before it
// alerts. The candle book hands each minute's sweeps in as it regroups them
// (candles.ts, `takeChanged`) and keeps what the rule ranked of the minute,
// so a regroup replaces the minute's entries rather than adding them again.
import type { AlertSide, StockCode, Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: a side alerts nothing until it holds 100 sweeps, and the cutoff
// is the ⌈n/100⌉-th largest of its n earlier sweeps, as `sweepThreshold`
// (lib/sweeps.ts) takes the top N% at N = 1. Under 100 that is the largest
// so far, so every new high would sound. See apinrdw/kumora#501.
const WARM_UP = 100
const TOP_PERCENT = 1

// Decision: a sweep whose second closed more than 10 s before the decision
// stays silent but still ranks: catch-up after a relay gap or a lagged feed
// isn't news. See apinrdw/kumora#502.
const MAX_AGE = 10_000

const SECOND = 1000

// One side's sweeps by lots: how many of each, and the distinct lots,
// largest first.
interface Ranking {
  size: number
  readonly counts: Map<number, number>
  readonly lots: Array<number>
}

// A sweep with an aggressor side: an auction match's prints have none and
// never rank.
type SidedSweep = Sweep & { readonly side: AlertSide }

const secondOf = (sweep: Sweep) =>
  Effect.sync(() => Math.floor(DateTime.toEpochMillis(sweep.time) / SECOND))

// A sweep the rule ranked, with the trade numbers it covered in its minute as
// grouped then: from its first trade up to the next sweep's (`end`), or on
// with none after it.
export interface RankedSweep {
  readonly sweep: SidedSweep
  readonly end: bigint | undefined
}

// A minute's sweeps with a side, each with the end of its trade numbers. Of a
// stored minute, these are the sweeps the rule ranked before.
export const rankedOf = (sweeps: ReadonlyArray<Sweep>) =>
  Effect.sync(() =>
    sweeps.flatMap((sweep, index): Array<RankedSweep> => {
      if (sweep.side === "none") return []
      const next = sweeps[index + 1]
      return [
        {
          sweep: { ...sweep, side: sweep.side },
          end: next === undefined ? undefined : BigInt(next.firstTrade),
        },
      ]
    })
  )

// Whether `entry` regroups a sweep the rule ranked: it shares the sweep's
// side and second and some of its trade numbers, so a late trade grew or
// split that sweep. A sweep with none of their trades is new.
const regroups = Effect.fnUntraced(function* (
  entry: RankedSweep,
  ranked: ReadonlyArray<RankedSweep>
) {
  const from = BigInt(entry.sweep.firstTrade)
  const second = yield* secondOf(entry.sweep)
  for (const { sweep, end } of ranked)
    if (
      sweep.side === entry.sweep.side &&
      (yield* secondOf(sweep)) === second &&
      (end === undefined || from < end) &&
      (entry.end === undefined || BigInt(sweep.firstTrade) < entry.end)
    )
      return true
  return false
})

// The index of the first distinct lots at or below `lots`.
const indexOf = (ranking: Ranking, lots: number) =>
  Effect.sync(() => {
    let low = 0
    let high = ranking.lots.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (ranking.lots[middle]! > lots) low = middle + 1
      else high = middle
    }
    return low
  })

const join = Effect.fnUntraced(function* (ranking: Ranking, lots: number) {
  const count = ranking.counts.get(lots) ?? 0
  if (count === 0) ranking.lots.splice(yield* indexOf(ranking, lots), 0, lots)
  ranking.counts.set(lots, count + 1)
  ranking.size += 1
})

// A sweep the ranking doesn't hold leaves it as it is.
const leave = Effect.fnUntraced(function* (ranking: Ranking, lots: number) {
  const count = ranking.counts.get(lots) ?? 0
  if (count === 0) return
  ranking.size -= 1
  if (count > 1) {
    ranking.counts.set(lots, count - 1)
    return
  }
  ranking.counts.delete(lots)
  ranking.lots.splice(yield* indexOf(ranking, lots), 1)
})

// The side's top-1% cutoff, or undefined while it is warming up.
const cutoffOf = (ranking: Ranking) =>
  Effect.sync(() => {
    if (ranking.size < WARM_UP) return undefined
    const rank = Math.ceil((ranking.size * TOP_PERCENT) / 100)
    let seen = 0
    for (const lots of ranking.lots) {
      seen += ranking.counts.get(lots)!
      if (seen >= rank) return lots
    }
    return undefined
  })

export const makeSweepAlerts = Effect.sync(() => {
  const rankings = new Map<string, Ranking>()

  // One code side's ranking.
  const rankingOf = (code: StockCode, side: AlertSide) =>
    Effect.sync(() => {
      const key = `${code} ${side}`
      let ranking = rankings.get(key)
      if (ranking === undefined) {
        ranking = { size: 0, counts: new Map(), lots: [] }
        rankings.set(key, ranking)
      }
      return ranking
    })

  // Whether a sweep alerts against its side's earlier sweeps, decided at
  // `now`; it joins them either way.
  const check = Effect.fnUntraced(function* (
    code: StockCode,
    sweep: SidedSweep,
    now: number
  ) {
    const ranking = yield* rankingOf(code, sweep.side)
    const cutoff = yield* cutoffOf(ranking)
    yield* join(ranking, sweep.lots)
    const closed = ((yield* secondOf(sweep)) + 1) * SECOND
    return (
      cutoff !== undefined && sweep.lots >= cutoff && now - closed <= MAX_AGE
    )
  })

  // One code's minute of sweeps, whole and in trade order, decided once the
  // object holds a trade timed `latest` and the decision is made at `now`,
  // both in epoch ms. `ranked` is what an earlier call returned for the minute: its
  // entries leave the ranking, and a sweep that regroups one of them joins
  // again without a decision. A new sweep is decided once its second has
  // closed, no later second holding a trade yet; until then it waits for a
  // later call (`pending`). An auction match has no side and never ranks.
  const decide = Effect.fnUntraced(function* ({
    code,
    ranked,
    sweeps,
    latest,
    now,
  }: {
    readonly code: StockCode
    readonly ranked: ReadonlyArray<RankedSweep>
    readonly sweeps: ReadonlyArray<Sweep>
    readonly latest: number
    readonly now: number
  }) {
    for (const { sweep } of ranked)
      yield* leave(yield* rankingOf(code, sweep.side), sweep.lots)
    const closedBefore = Math.floor(latest / SECOND)
    const again: Array<RankedSweep> = []
    const fresh: Array<RankedSweep> = []
    let pending = false
    for (const entry of yield* rankedOf(sweeps)) {
      if (yield* regroups(entry, ranked)) again.push(entry)
      else if ((yield* secondOf(entry.sweep)) < closedBefore) fresh.push(entry)
      else pending = true
    }
    for (const { sweep } of again)
      yield* join(yield* rankingOf(code, sweep.side), sweep.lots)
    const alerts: Array<RankedSweep> = []
    for (const entry of fresh)
      if (yield* check(code, entry.sweep, now)) alerts.push(entry)
    return { alerts, ranked: [...again, ...fresh], pending }
  })

  // Sweeps a restarted object stored, ranked without a decision: its
  // regroups find them ranked, as the ones it decides itself.
  const rank = Effect.fnUntraced(function* (
    code: StockCode,
    sweeps: ReadonlyArray<Sweep>
  ) {
    for (const { sweep } of yield* rankedOf(sweeps))
      yield* join(yield* rankingOf(code, sweep.side), sweep.lots)
  })

  return { decide, rank }
})
