// The trade chunks' bound (CODING_STANDARDS.md, "Bounded memory on a
// Worker") at the sparsest tape: one trade in each of 10,000 chunks, the
// newest 10,000 trades a starting object reads (trading-day.ts, TAPE_LIMIT),
// all inside one minute so a minute's read meets every chunk too.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeDayStore, type Sql } from "@/server/market-live/day-store"
import { TRADE_CHUNK } from "@/server/market-live/tape-chunks"

import { retainedBytes } from "../../support/retained-heap.ts"
import { memorySql } from "./sql"

const TRADES = 10_000
const MINUTE = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
)
const CODES = ["BBCA", "TLKM", "GOTO", "ASII"].map((code) =>
  StockCode.make(code)
)
const BUDGET = 32 * 1024 * 1024

const sparse = Array.from({ length: TRADES }, (_, k): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(k * TRADE_CHUNK + 1)),
  time: DateTime.makeUnsafe(MINUTE + k * 5),
  code: CODES[k % CODES.length]!,
  price: 9_000,
  lots: 1 + (k % 7),
  side: k % 2 === 0 ? "buy" : "sell",
  board: "RG",
  feeds: ["Stockbit"],
}))

// `sql` that records the most held, above `base`, after a collection at
// every 1,000th trade-chunk row read or written.
const sampled = (sql: Sql) => {
  const watch = { rows: 0, base: 0, peak: 0 }
  const exec: Sql["exec"] = (query, ...bindings) => {
    const rows = sql.exec(query, ...bindings)
    if (/^\s*(SELECT|INSERT)[^;]*trade_chunks/s.test(query)) {
      const passed = Math.floor(watch.rows / 1_000)
      watch.rows += query.trimStart().startsWith("SELECT") ? rows.length : 1
      if (Math.floor(watch.rows / 1_000) > passed)
        watch.peak = Math.max(watch.peak, retainedBytes() - watch.base)
    }
    return rows
  }
  // The most `run` held above what was held before it.
  const peakOf = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      watch.rows = 0
      watch.peak = 0
      watch.base = retainedBytes()
      const result = yield* run
      return { result, peak: watch.peak }
    })
  return { sql: { ...sql, exec }, peakOf }
}

describe("the trade chunks at the sparsest tape", () => {
  it.effect(
    "hold trades, not chunks, as a write and every collecting read scan",
    () =>
      Effect.gen(function* () {
        const { sql, peakOf } = sampled(memorySql())
        const store = yield* makeDayStore(sql)
        const end = DateTime.makeUnsafe(MINUTE + MINUTE_MS - 1)

        const write = yield* peakOf(
          store.write({
            trades: sparse,
            candles: [],
            footprints: [],
            livePrices: [],
            chunks: [],
            ajaibBooks: [],
            facts: {},
          })
        )
        const newest = yield* peakOf(store.newestTrades(TRADES))
        const at = yield* peakOf(store.tradesAt({ at: end }, TRADES))
        const between = yield* peakOf(
          store.tradesBetween(DateTime.makeUnsafe(MINUTE - 1), end)
        )

        assert.strictEqual(newest.result.length, TRADES)
        assert.strictEqual(at.result.length, TRADES)
        assert.strictEqual(between.result.length, TRADES)
        // 10,000 decoded trades hold a few MB; a scan that keeps each trade's
        // chunk holds 10,000 × 32 KB, past the Worker's 128 MB.
        const peaks = {
          write: write.peak,
          newestTrades: newest.peak,
          tradesAt: at.peak,
          tradesBetween: between.peak,
        }
        assert.deepStrictEqual(
          Object.entries(peaks).filter(([, peak]) => peak >= BUDGET),
          []
        )
      }),
    { timeout: 120_000 }
  )
})
