// Standout sweeps and sweep alerts (spec apinrdw/kumora#510, "Dashboard:
// the alert rule", and apinrdw/kumora#705): for each stock code and aggressor
// side, the day's sweeps ranked by lots. A sweep that reaches its side's
// top-1%, 5% or 10% cutoff among the sweeps before it stands out, and one at
// 1% alerts. The candle book hands each minute's sweeps in as it regroups them
// (candles.ts, `takeChanged`). The rule keeps what it ranked of each minute,
// so a regroup replaces the minute's entries rather than adding them again,
// and it decides the minutes in trade order.
import {
  STANDOUT_LEVELS,
  type AlertSide,
  type StandoutLevel,
  type StandoutSweep,
  type StockCode,
  type Sweep,
  type TradeNumber,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: a side lists and alerts nothing until it holds 100 sweeps, then its top 1%, 5% and 10%
// (apps/dashboard/docs/adr/0097-a-side-alerts-nothing-until-it-holds-100-sweeps.md)
//
// apps/e2e/tests/market-live-sweep-alerts.spec.ts and
// market-live-all-codes.spec.ts repeat the 100 (`WARM_UP`).
const WARM_UP = 100
const ALERT_LEVEL: StandoutLevel = 1

// Decision: a sweep closed over 10 s before the decision ranks but stays silent
// (apps/dashboard/docs/adr/0098-a-sweep-closed-over-10-s-ago-ranks-but-stays-silent.md)
//
// Only its alert stays silent: it still stands out and is listed in the All
// codes tab, which shows everything that stood out (spec apinrdw/kumora#705).
// tests/server/market-live/candles.test.ts repeats the 10 s (`reference`).
const MAX_AGE = 10_000

const SECOND = 1000

// One side's sweeps by lots: the distinct lots, largest first, and beside
// each how many sweeps have it.
// Two arrays side by side, not a Map from lots to count. At the
// worst day, 665,760 sweeps each of its own lots, the Map and a sorted
// array retained 38.6 MiB, past the spec's "under ~30 MB at worst"; the two
// arrays retain 12.0 MiB (sweep-alerts-memory.test.ts). See spec
// apinrdw/kumora#510.
interface Ranking {
  size: number
  readonly lots: Array<number>
  readonly counts: Array<number>
}

// A sweep with an aggressor side: an auction match's prints have none and
// never rank.
type SidedSweep = Sweep & { readonly side: AlertSide }

// A sweep the rule found standing out, as the page lists it, with its
// minute and whether it alerts.
interface Decided {
  readonly standout: StandoutSweep & { readonly sweep: SidedSweep }
  readonly minute: number
  readonly alerts: boolean
}

// A sweep as the candle book groups it, and the numbers its trades go by
// (candles.ts, `knownSweeps`): two sweeps of a minute, grouped at different
// times, hold a trade in common when they share one.
export interface KnownSweep {
  readonly sweep: Sweep
  readonly trades: ReadonlyArray<TradeNumber>
}

// A sided sweep as the rule ranks it: its second, in epoch seconds, and the
// numbers its trades go by.
interface PlacedSweep {
  readonly sweep: SidedSweep
  readonly second: number
  readonly trades: ReadonlyArray<TradeNumber>
}

// A minute's sweeps with a side, each placed, in trade order.
const placedOf = (sweeps: ReadonlyArray<KnownSweep>) =>
  Effect.sync(() =>
    sweeps.flatMap(({ sweep, trades }): Array<PlacedSweep> =>
      sweep.side === "none"
        ? []
        : [
            {
              sweep: { ...sweep, side: sweep.side },
              second: Math.floor(DateTime.toEpochMillis(sweep.time) / SECOND),
              trades,
            },
          ]
    )
  )

// The sweep each trade ranked in. Two ranked sweeps share a number only when
// both hold trades of one stored sweep (candles.ts, `knownSweeps`), so they
// have its side and second, and either answers for the number.
const byTrade = (ranked: ReadonlyArray<PlacedSweep>) =>
  Effect.sync(() => {
    const sweeps = new Map<TradeNumber, PlacedSweep>()
    for (const sweep of ranked)
      for (const trade of sweep.trades) sweeps.set(trade, sweep)
    return sweeps
  })

// Whether `entry` regroups a sweep the rule ranked: a trade of it ranked
// under its side and second, so a late trade grew or split that sweep. A
// sweep with no such trade is new, wherever its trade numbers fall among the
// ranked sweeps'.
// A ranked sweep is known by its trades, not by the trade numbers
// from its first to the next sweep's. That range takes in numbers the sweep
// never held, and a new sweep of late trades numbered there never alerted
// (both review rounds of spec apinrdw/kumora#510 found one).
const regroups = (
  entry: PlacedSweep,
  ranked: ReadonlyMap<TradeNumber, PlacedSweep>
) =>
  Effect.sync(() =>
    entry.trades.some((trade) => {
      const before = ranked.get(trade)
      return (
        before !== undefined &&
        before.sweep.side === entry.sweep.side &&
        before.second === entry.second
      )
    })
  )

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
  const index = yield* indexOf(ranking, lots)
  if (ranking.lots[index] === lots) ranking.counts[index]! += 1
  else {
    ranking.lots.splice(index, 0, lots)
    ranking.counts.splice(index, 0, 1)
  }
  ranking.size += 1
})

// A sweep the ranking doesn't hold leaves it as it is.
const leave = Effect.fnUntraced(function* (ranking: Ranking, lots: number) {
  const index = yield* indexOf(ranking, lots)
  if (ranking.lots[index] !== lots) return
  ranking.size -= 1
  if (ranking.counts[index]! > 1) {
    ranking.counts[index]! -= 1
    return
  }
  ranking.lots.splice(index, 1)
  ranking.counts.splice(index, 1)
})

// The level `lots` reaches among the side's sweeps: the first of
// STANDOUT_LEVELS whose cutoff, the ⌈n·N/100⌉-th largest of n (the top N%
// as `sweepThreshold` in lib/sweeps.ts takes it), it reaches. Undefined
// while the side is warming up or when it reaches none.
// One walk largest-first takes all three cutoffs, whose ranks
// only grow with the level, and stops at the sweep's own lots: a
// ranking's 10% walk is ten times its 1% one (spec apinrdw/kumora#705).
const levelOf = (ranking: Ranking, lots: number) =>
  Effect.sync(() => {
    if (ranking.size < WARM_UP) return undefined
    let level = 0
    let rank = Math.ceil((ranking.size * STANDOUT_LEVELS[level]!) / 100)
    let seen = 0
    for (let index = 0; index < ranking.lots.length; index++) {
      // The level's cutoff is here or further down, no larger.
      if (lots >= ranking.lots[index]!) return STANDOUT_LEVELS[level]
      seen += ranking.counts[index]!
      // The level's cutoff is here, larger than `lots`.
      while (seen >= rank) {
        level += 1
        if (level === STANDOUT_LEVELS.length) return undefined
        rank = Math.ceil((ranking.size * STANDOUT_LEVELS[level]!) / 100)
      }
    }
    return undefined
  })

// One code's minute while the rule keeps it.
interface Minute {
  readonly code: StockCode
  readonly minute: number
  // Its sweeps the rule ranked, in trade order.
  ranked: ReadonlyArray<PlacedSweep>
  // Its sweeps as the book last grouped them, whole and in trade order.
  sweeps: ReadonlyArray<KnownSweep>
  // Whether the book regrouped it since the rule last decided it.
  regrouped: boolean
  // Whether the book holds it (`release`).
  held: boolean
}

export const makeSweepAlerts = Effect.sync(() => {
  const rankings = new Map<string, Ranking>()
  // The minutes the rule keeps, with what it ranked of each: from the book's
  // first regroup of one until the book let it go and none of its sweeps
  // waits. A minute it doesn't keep is ranked as the store holds it, so the
  // kept ones are as few as the book's candles plus the latest second's.
  // The rule keeps them, not the book's candle. A flush lets a
  // candle go while its newest sweep still waits for a later trade, and the
  // reopened candle took that sweep from the store for ranked. See spec
  // apinrdw/kumora#510.
  const minutes = new Map<string, Minute>()
  // Those with a sweep to decide: regrouped since the last decision, or
  // waiting for its second to close.
  const undecided = new Set<Minute>()
  // The second of the latest trade at the last decision: every second
  // before it had closed.
  let closedBefore = -Infinity

  // One code side's ranking.
  const rankingOf = (code: StockCode, side: AlertSide) =>
    Effect.sync(() => {
      const key = `${code} ${side}`
      let ranking = rankings.get(key)
      if (ranking === undefined) {
        ranking = { size: 0, lots: [], counts: [] }
        rankings.set(key, ranking)
      }
      return ranking
    })

  // The level a sweep reaches against its side's earlier sweeps, and
  // whether it alerts, decided at `now`; it joins them either way.
  const check = Effect.fnUntraced(function* (
    code: StockCode,
    { sweep, second }: PlacedSweep,
    now: number
  ) {
    const ranking = yield* rankingOf(code, sweep.side)
    const level = yield* levelOf(ranking, sweep.lots)
    yield* join(ranking, sweep.lots)
    const closed = (second + 1) * SECOND
    return {
      level,
      alerts: level === ALERT_LEVEL && now - closed <= MAX_AGE,
    }
  })

  // One code's minute of sweeps as the book now groups them, whole and in
  // trade order: the next `decide` takes them. `stored` is what the store
  // held of the minute when the book took it, which the rule ranked before
  // unless it still keeps the minute.
  const regroup = Effect.fnUntraced(function* ({
    code,
    minute,
    stored,
    sweeps,
  }: {
    readonly code: StockCode
    readonly minute: number
    readonly stored: ReadonlyArray<KnownSweep>
    readonly sweeps: ReadonlyArray<KnownSweep>
  }) {
    const key = `${code} ${minute}`
    let kept = minutes.get(key)
    if (kept === undefined) {
      kept = {
        code,
        minute,
        ranked: yield* placedOf(stored),
        sweeps,
        regrouped: true,
        held: true,
      }
      minutes.set(key, kept)
    } else {
      kept.sweeps = sweeps
      kept.regrouped = true
      kept.held = true
    }
    undecided.add(kept)
  })

  // The book let a minute go, its sweeps stored as last regrouped. The rule
  // forgets it once none of its sweeps waits.
  const release = (code: StockCode, minute: number) =>
    Effect.sync(() => {
      const key = `${code} ${minute}`
      const kept = minutes.get(key)
      if (kept === undefined) return
      kept.held = false
      if (!undecided.has(kept)) minutes.delete(key)
    })

  // One kept minute decided: its ranked sweeps leave the ranking, and a
  // sweep that regroups one of them joins again without a decision. A new
  // sweep is decided once its second is before `closedBefore`; until then it
  // waits. An auction match has no side and never ranks. Returns the sweeps
  // that stand out, each with its level and whether it alerts, and whether
  // one waits.
  const decideMinute = Effect.fnUntraced(function* (kept: Minute, now: number) {
    for (const { sweep } of kept.ranked)
      yield* leave(yield* rankingOf(kept.code, sweep.side), sweep.lots)
    const before = yield* byTrade(kept.ranked)
    const ranked: Array<PlacedSweep> = []
    const fresh: Array<PlacedSweep> = []
    let waits = false
    for (const entry of yield* placedOf(kept.sweeps)) {
      if (yield* regroups(entry, before))
        yield* join(
          yield* rankingOf(kept.code, entry.sweep.side),
          entry.sweep.lots
        )
      else if (entry.second < closedBefore) fresh.push(entry)
      else {
        waits = true
        continue
      }
      ranked.push(entry)
    }
    const standouts: Array<Decided> = []
    for (const entry of fresh) {
      const { level, alerts } = yield* check(kept.code, entry, now)
      if (level !== undefined)
        standouts.push({
          standout: { code: kept.code, level, sweep: entry.sweep },
          minute: kept.minute,
          alerts,
        })
    }
    kept.ranked = ranked
    kept.regrouped = false
    return { standouts, waits }
  })

  // Decides every sweep that can be decided once the object holds a trade
  // timed `latest` and the decision is made at `now`, both in epoch ms: a
  // sweep's second has closed once `latest` is in a later one. The minutes
  // go in order, so each code's sweeps are decided in trade order whichever
  // the book regrouped first. Returns the sweeps that stand out, each with
  // its code, minute, level and whether it alerts.
  const decide = Effect.fnUntraced(function* ({
    latest,
    now,
  }: {
    readonly latest: number
    readonly now: number
  }) {
    const second = Math.floor(latest / SECOND)
    // A waiting minute the book left alone has nothing new to decide until
    // another second closes.
    const closedMore = second !== closedBefore
    closedBefore = second
    const standouts: Array<Decided> = []
    for (const kept of [...undecided].sort((a, b) => a.minute - b.minute)) {
      if (!kept.regrouped && !closedMore) continue
      const decided = yield* decideMinute(kept, now)
      standouts.push(...decided.standouts)
      if (decided.waits) continue
      undecided.delete(kept)
      if (!kept.held) minutes.delete(`${kept.code} ${kept.minute}`)
    }
    return standouts
  })

  // Sweeps a restarted object stored, ranked without a decision: its
  // regroups find them ranked, as the ones it decides itself.
  const rank = Effect.fnUntraced(function* (
    code: StockCode,
    sweeps: ReadonlyArray<Sweep>
  ) {
    for (const sweep of sweeps)
      if (sweep.side !== "none")
        yield* join(yield* rankingOf(code, sweep.side), sweep.lots)
  })

  // One code side's ranking, each distinct lots with its count, largest
  // first: what `rank` rebuilds of a stored day, so the two can be compared.
  const ranked = (code: StockCode, side: AlertSide) =>
    Effect.map(rankingOf(code, side), ({ lots, counts }) =>
      lots.map((value, index) => [value, counts[index]] as const)
    )

  return { regroup, release, decide, rank, ranked }
})
