// The busy-sized day the row budgets run on (spec apinrdw/kumora#554,
// "Testing Decisions"): a relay day sealed after the close, its trade chunks
// and code list (spec apinrdw/kumora#555), candles and broker code chunks as
// today's code stores them, written straight into the object's SQLite, and
// its tape summary as the seal writes it. The
// trading day makes the tables first, so the day has today's shape. It also
// holds the broker trades index and its rebuild's fact, as a day recorded
// before apinrdw/kumora#561 does.
import { gzipSync } from "node:zlib"

import {
  BOOK_DEPTH,
  Side,
  StockCode,
  encodeBookChunk,
  type BookDelta,
  type OrderBook,
} from "@workspace/relay"
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
import {
  TRADE_CHUNK,
  emptyRecords,
  putRecord,
} from "../src/server/market-live/tape-chunks.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import {
  BROKERS,
  BUSY_DAY,
  BUSY_MINUTES,
  BUSY_OPEN,
  BUSY_SPAN_MS,
  BUYER_STEP,
  FOREIGN_EVERY,
  SELLER_STEP,
  busyCodes,
  busyLevel,
} from "./busy-figures.ts"

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

const HOLES = new Set<number>(BUSY_DAY.holes)

// One trade chunk's records as tape-chunks.ts lays them out: trade n at
// BUSY_OPEN + n × BUSY_SPAN_MS / trades, code C(n mod codes), the code list's index
// n mod codes, and every hole lacking.
const tradeChunkOf = (chunk: number) =>
  Effect.sync(() => {
    const { trades, codes } = BUSY_DAY
    const records = emptyRecords()
    for (let slot = 0; slot < TRADE_CHUNK; slot++) {
      const number = chunk * TRADE_CHUNK + slot + 1
      if (number > trades || HOLES.has(number)) continue
      putRecord(records, slot, {
        time: BUSY_OPEN + Math.floor((number * BUSY_SPAN_MS) / trades),
        code: number % codes,
        price: 1000 + (number % 500),
        lots: 1 + (number % 20),
        side: Side.literals[number % 3]!,
        board: "RG",
        feeds: ["Stockbit"],
      })
    }
    return records
  })

// The busy code's book at frame `frame`: 20 levels a side around 1,000.
const bookAt = (frame: number, at: number): OrderBook => {
  const levels = (side: 1 | -1) =>
    Array.from({ length: BOOK_DEPTH }, (_, index) =>
      busyLevel(side, frame, index)
    )
  return {
    _tag: "OrderBook",
    code: StockCode.make(BUSY_DAY.bookCode),
    bids: levels(-1),
    offers: levels(1),
    bidLots: 50_000 + frame,
    offerLots: 60_000 + frame,
    at: DateTime.makeUnsafe(at),
    provenance: "Stockbit",
  }
}

// The busy code's chunks, gzipped as the day store stores them: one in
// BUSY_DAY.bookChunks of the day's minutes, each the book in force when its
// minute began, then a frame every 15 s with both sides changed.
const bookChunks = Effect.gen(function* () {
  const code = StockCode.make(BUSY_DAY.bookCode)
  const step = (index: number) =>
    Math.floor((index * BUSY_DAY.bookChunks) / BUSY_MINUTES)
  const chunks: Array<readonly [number, ArrayBuffer]> = []
  let last: OrderBook | undefined
  let frame = 0
  for (let index = 0; index < BUSY_MINUTES; index++) {
    if (index > 0 && step(index) === step(index - 1)) continue
    const minute = BUSY_OPEN + index * 60_000
    const start = last
    const deltas: Array<BookDelta> = []
    for (let second = 0; second < 60; second += 15) {
      const at = minute + second * 1_000
      const book = bookAt(frame++, at)
      deltas.push({
        servedAt: book.at,
        at: book.at,
        ...(last === undefined ? { provenance: book.provenance } : {}),
        bids: book.bids,
        offers: book.offers,
        bidLots: book.bidLots,
        offerLots: book.offerLots,
      })
      last = book
    }
    const text = yield* encodeBookChunk({
      code,
      minute: DateTime.makeUnsafe(minute),
      ...(start === undefined ? {} : { start }),
      deltas,
    })
    chunks.push([minute, new Uint8Array(gzipSync(text)).buffer])
  }
  return chunks
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
      for (const number of holes)
        exec(
          "INSERT INTO walk_trades VALUES (?, ?, ?, ?, 'RG')",
          number,
          `C${number % codes}`,
          1000 + (number % 500),
          1 + (number % 20)
        )
      exec(
        `${numbers(codes * BUSY_MINUTES)} INSERT INTO candles
        SELECT 'C' || (x % ${codes}), ${BUSY_OPEN} + (x / ${codes}) * 60000, x, 1000,
          x, 1001, ${BUSY_OPEN} + (x / ${codes}) * 60000 + 59000, 1002, 999, 100,
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
  for (let chunk = 0; chunk < Math.ceil(trades / TRADE_CHUNK); chunk++) {
    const records = yield* tradeChunkOf(chunk)
    exec("INSERT INTO trade_chunks VALUES (?, ?)", chunk, records.buffer)
  }
  for (const [minute, chunk] of yield* bookChunks)
    exec(
      "INSERT INTO book_chunks VALUES (?, ?, ?)",
      BUSY_DAY.bookCode,
      minute,
      chunk
    )
  const facts: ReadonlyArray<readonly [string, string]> = [
    [Fact.tapeSource, "relay"],
    [
      Fact.tradeCodes,
      JSON.stringify(Array.from({ length: codes }, (_, at) => `C${at}`)),
    ],
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
