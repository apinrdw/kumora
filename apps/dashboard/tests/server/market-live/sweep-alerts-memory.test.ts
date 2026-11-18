// The alert rule's bound (CODING_STANDARDS.md, "Bounded memory on a Worker")
// at the worst day the research for spec apinrdw/kumora#510 put it at: about
// 660,000 sweeps over 900 codes, a busy code holding 18,000
// (docs/research/whole-tape-sweep-cutoffs.md on branch
// research/whole-tape-sweep-cutoffs), and every sweep of a code's side of
// its own lots, so each is an entry of its ranking.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type Sweep,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeCandleBook } from "@/server/market-live/candles"
import { makeDayStore, type Sql } from "@/server/market-live/day-store"
import { noCells } from "@/server/market-live/footprint-cells"
import { makeSweepAlerts } from "@/server/market-live/sweep-alerts"

import { retainedHeap } from "../../support/retained-heap.ts"
import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
import { memorySql } from "./sql"

const FIRST = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T08:58:00+07:00")
)
const MINUTE = 60_000
const BUSY_CODES = 30
// A busy code's sweeps a minute: 17,958 over the day.
const BUSY_SWEEPS = 41
// Any other code sweeps once in three minutes: 146 over the day.
const QUIET_EVERY = 3
const SWEEPS =
  BUSY_CODES * BUSY_SWEEPS * FULL_DAY_MINUTES +
  (FULL_DAY_CODES - BUSY_CODES) * (FULL_DAY_MINUTES / QUIET_EVERY)
// A prime above any side's sweeps: a side's k-th sweep has lots of its own.
const LOTS = 9001

const codes = Array.from({ length: FULL_DAY_CODES }, (_, index) =>
  StockCode.make(`C${String(index).padStart(3, "0")}`)
)

// The lots of a code's `nth` sweep of the day, its sides taking turns.
const lotsOf = (nth: number) => 1 + (((nth >> 1) * 7919) % LOTS)

// One code's sweeps in one minute of the worst day, made when asked for, so
// the test holds none of them. They fall in the minute's last 10 s, the last
// in its last second.
const sweepsOf = (code: number, minute: number): Array<Sweep> => {
  const busy = code < BUSY_CODES
  if (!busy && (minute + code) % QUIET_EVERY !== 0) return []
  const count = busy ? BUSY_SWEEPS : 1
  const first = busy ? minute * BUSY_SWEEPS : Math.floor(minute / QUIET_EVERY)
  return Array.from({ length: count }, (_, index) => {
    const lots = lotsOf(first + index)
    const second =
      index === count - 1 ? 59 : 50 + Math.floor((index * 9) / BUSY_SWEEPS)
    return {
      side: (first + index) % 2 === 0 ? "buy" : "sell",
      firstTrade: TradeNumber.make(String(minute * 100 + index + 1)),
      time: DateTime.makeUnsafe(FIRST + minute * MINUTE + second * 1000),
      first: 100,
      last: 100,
      lots,
      value: lots * 100 * 100,
      trades: 1,
    }
  })
}

// A database that reports the heap each statement's rows are handed back
// into, while `watching`: the heap over `base` after a full collection, the
// rows still held. It measures one statement in `EVERY`, the first included.
const EVERY = 8
const watchedSql = () => {
  const sql = memorySql()
  const watch = { watching: false, base: 0, most: 0, statements: 0 }
  const watched: Sql = {
    ...sql,
    exec: (query, ...bindings) => {
      const rows = sql.exec(query, ...bindings)
      if (watch.watching && watch.statements++ % EVERY === 0)
        watch.most = Math.max(
          watch.most,
          Effect.runSync(retainedHeap) - watch.base
        )
      return rows
    },
  }
  return { watched, watch }
}

// The worst day's sweeps written to a day store as footprint rows, a minute
// a write, and nothing else.
const storeDay = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const cells = yield* noCells
  for (let minute = 0; minute < FULL_DAY_MINUTES; minute++)
    yield* store.write({
      trades: [],
      candles: [],
      footprints: codes.flatMap((code, index) => {
        const sweeps = sweepsOf(index, minute)
        return sweeps.length === 0
          ? []
          : [
              {
                code,
                minute: FIRST + minute * MINUTE,
                cells,
                sweeps,
                lastTrade: BigInt(sweeps.at(-1)!.firstTrade),
              },
            ]
      }),
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {},
    })
})

// A busy code's buy side holds 8,979 sweeps: its cutoff is the 90th largest.
const busyCutoff = Array.from(
  { length: (BUSY_SWEEPS * FULL_DAY_MINUTES) / 2 },
  (_, nth) => lotsOf(nth * 2)
).sort((a, b) => b - a)[89]!

// Spec apinrdw/kumora#510: "under ~30 MB at worst".
const BOUND = 30 * 1024 * 1024

describe("the alert rule at the worst day", () => {
  it.effect(
    "a restart reads the day's 665,760 stored sweeps from the database and ranks them within a bounded heap, and decides against them",
    () =>
      Effect.gen(function* () {
        const { watched, watch } = watchedSql()
        const store = yield* makeDayStore(watched, { today: true })
        yield* storeDay(store)
        watch.base = yield* retainedHeap
        const book = yield* makeCandleBook(store, () => {})
        watch.watching = true
        yield* book.rankStored
        watch.watching = false
        // The rows a statement hands back count while the store reads them.
        assert.isBelow(
          watch.most,
          BOUND,
          `${(watch.most / 2 ** 20).toFixed(1)} MiB held while reading`
        )
        const held = (yield* retainedHeap) - watch.base
        assert.isBelow(
          held,
          BOUND,
          `${(held / 2 ** 20).toFixed(1)} MiB retained`
        )

        // The ranking is there: a buy sweep at a busy code's cutoff alerts,
        // and one a lot under another's doesn't.
        const after = FIRST + FULL_DAY_MINUTES * MINUTE
        const trade = (
          code: StockCode,
          number: number,
          second: number,
          lots: number
        ): RunningTrade => ({
          tradeNumber: TradeNumber.make(String(number)),
          time: DateTime.makeUnsafe(after + second * 1000),
          code,
          price: 100,
          lots,
          side: "buy",
          board: "RG",
          feeds: ["Ajaib"],
        })
        yield* TestClock.setTime(after + 1500)
        yield* book.trade(undefined, trade(codes[0]!, 1, 0, busyCutoff))
        yield* book.trade(undefined, trade(codes[1]!, 2, 0, busyCutoff - 1))
        yield* book.trade(undefined, trade(codes[2]!, 3, 1, 1))
        assert.deepStrictEqual(
          (yield* book.takeChanged(new Set())).sweepAlerts.map((alert) => [
            alert.code,
            alert.lots,
          ]),
          [[codes[0], busyCutoff]]
        )
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "a live day of them leaves the rule holding its rankings and the minutes still waiting, not the day's minutes",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(SWEEPS, 665_760)
        const before = yield* retainedHeap
        const rule = yield* makeSweepAlerts
        let alerts = 0
        // Each minute's sweeps regrouped, decided with its last second
        // still open, then let go, as a flush does.
        for (let minute = 0; minute < FULL_DAY_MINUTES; minute++) {
          for (let code = 0; code < FULL_DAY_CODES; code++) {
            const sweeps = sweepsOf(code, minute)
            if (sweeps.length > 0)
              yield* rule.regroup({
                code: codes[code]!,
                minute,
                stored: [],
                sweeps,
              })
          }
          const latest = FIRST + minute * MINUTE + 59_000
          alerts += (yield* rule.decide({ latest, now: latest })).length
          for (const code of codes) yield* rule.release(code, minute)
        }
        const held = (yield* retainedHeap) - before
        assert.isBelow(
          held,
          BOUND,
          `${(held / 2 ** 20).toFixed(1)} MiB retained`
        )
        // The rule decided them: about 1% of a busy code's sweeps alert.
        assert.isAbove(alerts, 1000)
        // Keeps `rule` alive past the measurement.
        yield* rule.release(codes[0]!, 0)
      }),
    { timeout: 60_000 }
  )
})
