// The busy-sized day the row budgets run on (spec apinrdw/kumora#554,
// "Testing Decisions"): a relay day sealed after the close, its tape, candles
// and broker code chunks as today's code stores them, written straight into
// the object's SQLite, and its tape summary as the seal writes it. The
// trading day makes the tables first, so the day has today's shape. It also
// holds the broker trades index and its rebuild's fact, as a day recorded
// before apinrdw/kumora#561 does.
import { Clock, DateTime, Effect } from "effect"

import { BROKER_TOTALS_VERSION } from "../src/server/broker-totals/version.ts"
import {
  BROKER_TRADES_INDEX,
  CHUNK,
  DroppedFact,
  RECORD,
  SOURCE,
  Source,
  summarizeTape,
} from "../src/server/market-live/broker-codes.ts"
import { durableSql } from "../src/server/market-live/durable-sql.ts"
import {
  Fact,
  ORDER_FLOW_BUILT,
  SWEEP_BROKERS_BUILT,
} from "../src/server/market-live/day-store.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import {
  BROKERS,
  BUSY_DAY,
  BUYER_STEP,
  FOREIGN_EVERY,
  SELLER_STEP,
  busyCodes,
} from "./busy-figures.ts"

const OPEN = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
)
// 09:00 to 16:15, a trade every 17.9 ms.
const SPAN_MS = 435 * 60_000
const MINUTES = 435

const encoder = new TextEncoder()

// One chunk's records as broker-codes.ts lays them out, every trade's codes
// from Ajaib.
const chunkOf = (chunk: number) =>
  Effect.sync(() => {
    const codes = new Uint8Array(CHUNK * RECORD)
    for (let slot = 0; slot < CHUNK; slot++) {
      const number = chunk * CHUNK + slot + 1
      const each = busyCodes(number)
      codes.set(
        encoder.encode(
          `${each.buyer}${each.buyerType}${each.seller}${each.sellerType}`
        ),
        slot * RECORD
      )
      codes[slot * RECORD + SOURCE] = Source.ajaib
    }
    return codes
  })

// 1..`count` as `n(x)`, for an INSERT … SELECT. Every figure is written
// into the statement: workerd binds a JavaScript number as a REAL, so
// `'C' || (x % ?)` would read `C1.0`.
const numbers = (count: number) =>
  `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${count})`

// The busy day in `storage`, built unless it already is; how long the
// build took, in ms, 0 when it was built before.
export const buildBusyDay = Effect.fnUntraced(function* (
  storage: DurableObjectStorage
) {
  const exec = (query: string, ...bindings: ReadonlyArray<SqlStorageValue>) =>
    storage.sql.exec(query, ...bindings).toArray()
  const started = yield* Clock.currentTimeMillis
  yield* Effect.scoped(
    makeTradingDay({
      date: BUSY_DAY.date,
      sql: yield* durableSql(storage),
      viewers: Effect.succeed([]),
      viewersOf: () => Effect.succeed([]),
    })
  )
  if (exec("SELECT 1 FROM facts WHERE key = ?", Fact.sealed).length > 0)
    return 0
  const { trades, codes, holes } = BUSY_DAY
  const brokers = BROKERS.join("")
  yield* Effect.sync(() =>
    storage.transactionSync(() => {
      exec(
        `${numbers(trades)} INSERT INTO trades
        SELECT x, ${OPEN} + x * ${SPAN_MS} / ${trades}, 'C' || (x % ${codes}),
          1000 + x % 500, 1 + x % 20,
          CASE x % 3 WHEN 0 THEN 'buy' WHEN 1 THEN 'sell' ELSE 'none' END,
          'RG', 'Stockbit'
        FROM n WHERE x NOT IN (${holes.join(", ")})`
      )
      for (const number of holes)
        exec(
          "INSERT INTO walk_trades VALUES (?, ?, ?, ?, 'RG')",
          number,
          `C${number % codes}`,
          1000 + (number % 500),
          1 + (number % 20)
        )
      exec(
        `${numbers(codes * MINUTES)} INSERT INTO candles
        SELECT 'C' || (x % ${codes}), ${OPEN} + (x / ${codes}) * 60000, x, 1000,
          x, 1001, ${OPEN} + (x / ${codes}) * 60000 + 59000, 1002, 999, 100,
          10000000, 40, 5000000, 5000000
        FROM n`
      )
      exec(BROKER_TRADES_INDEX)
      exec(
        `${numbers(trades)} INSERT INTO broker_trades
        SELECT substr('${brokers}', (x * ${BUYER_STEP}) % ${BROKERS.length} * 2 + 1, 2),
          CASE x % ${FOREIGN_EVERY} WHEN 0 THEN 'F' ELSE 'D' END, 'buy', x FROM n
        UNION ALL
        SELECT substr('${brokers}', (x * ${SELLER_STEP}) % ${BROKERS.length} * 2 + 1, 2),
          CASE (x + 1) % ${FOREIGN_EVERY} WHEN 0 THEN 'F' ELSE 'D' END, 'sell', x FROM n`
      )
    })
  )
  for (let chunk = 0; chunk < Math.ceil(trades / CHUNK); chunk++) {
    const records = yield* chunkOf(chunk)
    exec("INSERT INTO broker_code_chunks VALUES (?, ?)", chunk, records.buffer)
  }
  const facts: ReadonlyArray<readonly [string, string]> = [
    [Fact.tapeSource, "relay"],
    [Fact.brokerCodesN, String(trades)],
    [Fact.codesComplete, "true"],
    [
      Fact.crossCheck,
      JSON.stringify({ walkedTo: String(trades), ended: true }),
    ],
    [DroppedFact.brokerTrades, "built"],
    // Built by an older build version, as a day the reconcile cron has yet
    // to poke: with a broker totals DB, a batch runs its buildable check.
    [Fact.brokerTotals, String(BROKER_TOTALS_VERSION - 1)],
    [Fact.orderFlowBuilt, ORDER_FLOW_BUILT],
    [Fact.sweepBrokersBuilt, SWEEP_BROKERS_BUILT],
    [Fact.gaps, '{"gaps":[]}'],
    [Fact.sealed, "2026-11-09T10:00:00.000Z"],
  ]
  for (const [key, value] of facts)
    exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)
  yield* summarizeTape(yield* durableSql(storage))
  return (yield* Clock.currentTimeMillis) - started
})
