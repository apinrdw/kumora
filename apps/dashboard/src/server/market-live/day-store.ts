// Where a trading day keeps what it recorded (spec apinrdw/kumora#138,
// "Storage and cost"): the trading-day Durable Object's SQLite database. The
// object hands its `ctx.storage.sql`; the tests hand Node's SQLite. Every
// write of a flush lands in one transaction, so a restart finds the trades,
// candles, last frames and book chunks of the same instant.
import { gunzipSync, gzipSync } from "node:zlib"

import {
  StockCode,
  TradeNumber,
  TradeNumberValue,
  type Candle,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { CandleFigures } from "./candles.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

export type SqlValue = string | number | null | Uint8Array

// The part of SQLite the store needs: Cloudflare's `SqlStorage` and Node's
// `DatabaseSync` both fit behind it.
export interface Sql {
  readonly exec: (
    query: string,
    ...bindings: ReadonlyArray<SqlValue>
  ) => ReadonlyArray<Record<string, SqlValue>>
  readonly transaction: (write: () => void) => void
}

// One code's candle for one minute, with the trade numbers (or, for an index,
// the frame times) its open and close came from, so a restarted object keeps
// adding to it.
interface StoredCandle {
  readonly code: StockCode
  readonly minute: number
  readonly figures: CandleFigures
}

// One code's order book chunk for one minute, encoded.
export interface StoredChunk {
  readonly code: StockCode
  readonly minute: number
  readonly chunk: string
}

// What one flush writes.
interface Flush {
  readonly trades: ReadonlyArray<RunningTrade>
  readonly candles: ReadonlyArray<StoredCandle>
  readonly livePrices: ReadonlyArray<LivePrice>
  readonly chunks: ReadonlyArray<StoredChunk>
  readonly facts: Readonly<Record<string, string>>
}

// Decision: a trade is one row keyed by its number as the INTEGER PRIMARY
// KEY, the table's rowid, with no secondary index, so each insert writes one
// row (spec apinrdw/kumora#138, "Storage and cost"). A day's numbers are far
// below 2^53, so they travel as plain numbers. Candles, last `liveprice`
// frames and book chunks are keyed tables WITHOUT ROWID, replaced at most
// once a minute.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trades (
    number INTEGER PRIMARY KEY,
    time INTEGER NOT NULL,
    code TEXT NOT NULL,
    price REAL NOT NULL,
    lots REAL NOT NULL,
    side TEXT NOT NULL,
    board TEXT NOT NULL,
    feeds TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS candles (
    code TEXT NOT NULL,
    minute INTEGER NOT NULL,
    open_order INTEGER NOT NULL,
    open REAL NOT NULL,
    close_order INTEGER NOT NULL,
    close REAL NOT NULL,
    close_time INTEGER NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    volume REAL NOT NULL,
    value REAL NOT NULL,
    frequency REAL NOT NULL,
    PRIMARY KEY (code, minute)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS live_prices (
    code TEXT PRIMARY KEY,
    frame TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS book_chunks (
    code TEXT NOT NULL,
    minute INTEGER NOT NULL,
    chunk BLOB NOT NULL,
    PRIMARY KEY (code, minute)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS facts (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
]

// The keys of the facts table.
export const Fact = {
  sealed: "sealed",
  gaps: "gaps",
  feedDowns: "feed-downs",
} as const

// The most a stored trade's time can run before the time of the trade
// numbered before it: Ajaib's and the backfill's rounding to the second.
const TIME_SKEW_MS = 1_000

const numberOf = (value: SqlValue | undefined) => Number(value)
const textOf = (value: SqlValue | undefined) => String(value)

// Rows are the store's own writes, so they are read back without a decode.
const tradeOf = (row: Record<string, SqlValue>): RunningTrade => ({
  tradeNumber: TradeNumber.make(textOf(row.number)),
  time: DateTime.makeUnsafe(numberOf(row.time)),
  code: StockCode.make(textOf(row.code)),
  price: numberOf(row.price),
  lots: numberOf(row.lots),
  side: textOf(row.side) as RunningTrade["side"],
  board: textOf(row.board) as RunningTrade["board"],
  feeds: textOf(row.feeds).split(",") as RunningTrade["feeds"],
})

const storedCandleOf = (row: Record<string, SqlValue>): StoredCandle => ({
  code: StockCode.make(textOf(row.code)),
  minute: numberOf(row.minute),
  figures: {
    openOrder: BigInt(numberOf(row.open_order)),
    open: numberOf(row.open),
    closeOrder: BigInt(numberOf(row.close_order)),
    close: numberOf(row.close),
    closeTime: numberOf(row.close_time),
    high: numberOf(row.high),
    low: numberOf(row.low),
    volume: numberOf(row.volume),
    value: numberOf(row.value),
    frequency: numberOf(row.frequency),
  },
})

const candleOf = ({ code, minute, figures }: StoredCandle): Candle => ({
  code,
  minute: DateTime.makeUnsafe(minute),
  open: figures.open,
  high: figures.high,
  low: figures.low,
  close: figures.close,
  volume: figures.volume,
  value: figures.value,
  frequency: figures.frequency,
})

const livePriceOf = (frame: SqlValue | undefined): LivePrice => {
  const { time, ...rest } = JSON.parse(textOf(frame)) as Omit<
    LivePrice,
    "time"
  > & { readonly time: number }
  return { ...rest, time: DateTime.makeUnsafe(time) }
}

// Decision: a book chunk is stored gzipped (spec apinrdw/kumora#138, "Storage
// and cost"), with Node's zlib that the Worker's nodejs_compat flag provides:
// synchronous, so a flush stays one transaction.
const chunkOf = (blob: SqlValue | undefined) =>
  new TextDecoder().decode(gunzipSync(blob as Uint8Array))

export const makeDayStore = (sql: Sql) =>
  Effect.sync(() => {
    for (const statement of SCHEMA) sql.exec(statement)

    const write = (flush: Flush) =>
      Effect.sync(() =>
        sql.transaction(() => {
          for (const trade of flush.trades)
            // A number is written once: a copy can't replace it.
            sql.exec(
              "INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              Number(trade.tradeNumber),
              DateTime.toEpochMillis(trade.time),
              trade.code,
              trade.price,
              trade.lots,
              trade.side,
              trade.board,
              trade.feeds.join(",")
            )
          for (const { code, minute, figures } of flush.candles)
            sql.exec(
              "INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              code,
              minute,
              Number(figures.openOrder),
              figures.open,
              Number(figures.closeOrder),
              figures.close,
              figures.closeTime,
              figures.high,
              figures.low,
              figures.volume,
              figures.value,
              figures.frequency
            )
          for (const price of flush.livePrices)
            sql.exec(
              "INSERT OR REPLACE INTO live_prices VALUES (?, ?)",
              price.code,
              JSON.stringify({
                ...price,
                time: DateTime.toEpochMillis(price.time),
              })
            )
          for (const { code, minute, chunk } of flush.chunks)
            sql.exec(
              "INSERT OR REPLACE INTO book_chunks VALUES (?, ?, ?)",
              code,
              minute,
              new Uint8Array(gzipSync(chunk))
            )
          for (const [key, value] of Object.entries(flush.facts))
            sql.exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)
        })
      )

    const hasTrade = (tradeNumber: TradeNumber) =>
      Effect.sync(
        () =>
          sql.exec("SELECT 1 FROM trades WHERE number = ?", Number(tradeNumber))
            .length > 0
      )

    // The lowest or highest number held. One aggregate per statement: SQLite
    // reads a lone min() or max() off the primary key's end, but scans the
    // whole table for a statement that asks for both.
    const boundTrade = (bound: "min" | "max") => {
      const [row] = sql.exec(`SELECT ${bound}(number) AS number FROM trades`)
      return row === undefined || row.number === null
        ? undefined
        : numberOf(row.number)
    }

    const highestTrade = Effect.sync(() => {
      const high = boundTrade("max")
      return high === undefined
        ? undefined
        : TradeNumberValue.make(BigInt(high))
    })

    // How many trades the day stored so far: the index row's figure.
    const storedTrades = Effect.sync(() =>
      numberOf(sql.exec("SELECT count(*) AS count FROM trades")[0]?.count)
    )

    // The newest `limit` trades, ascending.
    const newestTrades = (limit: number) =>
      Effect.sync(() =>
        sql
          .exec("SELECT * FROM trades ORDER BY number DESC LIMIT ?", limit)
          .map(tradeOf)
          .reverse()
      )

    // The trade with the lowest number at or above `number`.
    const firstFrom = (number: number) =>
      sql.exec(
        "SELECT number, time FROM trades WHERE number >= ? ORDER BY number LIMIT 1",
        number
      )[0]

    // Decision: a trade number at or above every trade at or before an
    // instant is found by a binary search on the trade number, which IDX
    // hands out in matching order, so the table needs no index on time. The
    // stored times do not grow with the number exactly: Stockbit times a
    // trade to the millisecond, Ajaib and the backfill to the second, so a
    // trade's stored time runs at most TIME_SKEW_MS before the one before
    // it. The search therefore looks for the highest number whose time is
    // within the skew after the instant: every trade at or before the
    // instant is at or below it, and the query's time filter drops the rest.
    const highestWithin = (cutoff: number) => {
      const envelope = cutoff + TIME_SKEW_MS
      let low = boundTrade("min")
      let high = boundTrade("max")
      if (low === undefined || high === undefined) return undefined
      let found: number | undefined
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const row = firstFrom(middle)
        if (row === undefined || numberOf(row.number) > high) {
          high = middle - 1
          continue
        }
        if (numberOf(row.time) <= envelope) {
          found = numberOf(row.number)
          low = found + 1
        } else high = middle - 1
      }
      return found
    }

    // The newest `limit` trades at or before `at`, ascending: SQLite walks
    // the primary key down from the search's number and skips the rows the
    // skew lets past it.
    const tradesAt = (at: DateTime.Utc, limit: number) =>
      Effect.sync(() => {
        const cutoff = DateTime.toEpochMillis(at)
        const found = highestWithin(cutoff)
        if (found === undefined) return []
        return sql
          .exec(
            "SELECT * FROM trades WHERE number <= ? AND time <= ? ORDER BY number DESC LIMIT ?",
            found,
            cutoff,
            limit
          )
          .map(tradeOf)
          .reverse()
      })

    // The trades after `after` and at or before `through`, ascending. The
    // numbers start from a search two skews before `after`: every trade at
    // or below that number is at or before `after`, so none is missed, and
    // the time filter decides the rest.
    const tradesBetween = (after: DateTime.Utc, through: DateTime.Utc) =>
      Effect.sync(() => {
        const from = DateTime.toEpochMillis(after)
        const to = DateTime.toEpochMillis(through)
        const last = highestWithin(to)
        if (last === undefined) return []
        const first = highestWithin(from - 2 * TIME_SKEW_MS) ?? 0
        return sql
          .exec(
            "SELECT * FROM trades WHERE number > ? AND number <= ? AND time > ? AND time <= ? ORDER BY number",
            first,
            last,
            from,
            to
          )
          .map(tradeOf)
      })

    // Every code with a candle.
    const candleCodes = Effect.sync(() =>
      sql
        .exec("SELECT DISTINCT code FROM candles")
        .map((row) => StockCode.make(textOf(row.code)))
    )

    // One code's stored candles, with their trade orders.
    const storedCandlesOf = (code: StockCode) =>
      Effect.sync(() =>
        sql
          .exec("SELECT * FROM candles WHERE code = ?", code)
          .map(storedCandleOf)
      )

    // One code's candles, ascending by minute.
    const candlesOf = (code: StockCode) =>
      Effect.sync(() =>
        sql
          .exec("SELECT * FROM candles WHERE code = ? ORDER BY minute", code)
          .map((row) => candleOf(storedCandleOf(row)))
      )

    const livePrices = Effect.sync(() =>
      sql
        .exec("SELECT frame FROM live_prices")
        .map((row) => livePriceOf(row.frame))
    )

    const livePrice = (code: StockCode) =>
      Effect.sync(() => {
        const [row] = sql.exec(
          "SELECT frame FROM live_prices WHERE code = ?",
          code
        )
        return row === undefined ? undefined : livePriceOf(row.frame)
      })

    // The chunk of `code` for the minute holding `minute`, or the latest
    // before it: the book in force then.
    const chunkAt = (code: StockCode, minute: number) =>
      Effect.sync(() => {
        const [row] = sql.exec(
          "SELECT chunk FROM book_chunks WHERE code = ? AND minute <= ? ORDER BY minute DESC LIMIT 1",
          code,
          minute
        )
        return row === undefined ? undefined : chunkOf(row.chunk)
      })

    // Every code's latest chunk: the books a restarted object starts from.
    const latestChunks = Effect.sync(() =>
      sql
        .exec(
          `SELECT chunk FROM book_chunks AS b
           WHERE minute = (SELECT max(minute) FROM book_chunks WHERE code = b.code)`
        )
        .map((row) => chunkOf(row.chunk))
    )

    const fact = (key: string) =>
      Effect.sync(() => {
        const [row] = sql.exec("SELECT value FROM facts WHERE key = ?", key)
        return row === undefined ? undefined : textOf(row.value)
      })

    return {
      write,
      hasTrade,
      highestTrade,
      storedTrades,
      newestTrades,
      tradesAt,
      tradesBetween,
      candleCodes,
      storedCandlesOf,
      candlesOf,
      livePrices,
      livePrice,
      chunkAt,
      latestChunks,
      fact,
    }
  })
