// Sweep alerts (spec apinrdw/kumora#510, "Dashboard: the alert rule"): for
// each stock code and aggressor side, the day's sweeps ranked by lots, and a
// sweep that reaches its side's top-1% cutoff among the sweeps before it
// alerts. The candle book hands each minute's sweeps in as it regroups them
// (candles.ts, `takeChanged`) and keeps what the rule ranked of the minute,
// so a regroup replaces the minute's entries rather than adding them again.
import type { StockCode, Sweep } from "@workspace/relay"
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
type SidedSweep = Sweep & { readonly side: "buy" | "sell" }

const sided = (sweeps: ReadonlyArray<Sweep>) =>
  sweeps.filter((sweep): sweep is SidedSweep => sweep.side !== "none")

const secondOf = (sweep: Sweep) =>
  Math.floor(DateTime.toEpochMillis(sweep.time) / SECOND)

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
  const rankingOf = (code: StockCode, side: SidedSweep["side"]) =>
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
    const closed = (secondOf(sweep) + 1) * SECOND
    return (
      cutoff !== undefined && sweep.lots >= cutoff && now - closed <= MAX_AGE
    )
  })

  // One code's minute of sweeps, whole and in trade order, decided once the
  // object holds a trade timed `latest` (epoch ms) and the decision is made
  // at `now`. `ranked` is what an earlier call returned for the minute: its
  // entries leave the ranking, and its seconds never alert again. A sweep
  // whose second hasn't closed, no later second holding a trade yet, waits
  // for a later call (`pending`); an auction match has no side and never
  // ranks.
  const decide = Effect.fnUntraced(function* (
    code: StockCode,
    ranked: ReadonlyArray<Sweep>,
    sweeps: ReadonlyArray<Sweep>,
    latest: number,
    now: number
  ) {
    const before = sided(ranked)
    const decided = new Set(before.map(secondOf))
    for (const sweep of before)
      yield* leave(yield* rankingOf(code, sweep.side), sweep.lots)
    const minute = sided(sweeps)
    const closed = minute.filter(
      (sweep) => secondOf(sweep) < Math.floor(latest / SECOND)
    )
    const again = closed.filter((sweep) => decided.has(secondOf(sweep)))
    for (const sweep of again)
      yield* join(yield* rankingOf(code, sweep.side), sweep.lots)
    const alerts: Array<SidedSweep> = []
    for (const sweep of closed)
      if (!decided.has(secondOf(sweep)) && (yield* check(code, sweep, now)))
        alerts.push(sweep)
    return { alerts, ranked: closed, pending: closed.length < minute.length }
  })

  // Sweeps a restarted object stored, ranked without a decision: its
  // regroups find them ranked, as the ones it decides itself.
  const rank = Effect.fnUntraced(function* (
    code: StockCode,
    sweeps: ReadonlyArray<Sweep>
  ) {
    for (const sweep of sided(sweeps))
      yield* join(yield* rankingOf(code, sweep.side), sweep.lots)
  })

  return { decide, rank }
})
