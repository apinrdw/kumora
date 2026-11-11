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

import type { StoredCandle } from "./candles.ts"
import type { StoredAjaibBook } from "./order-books.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

export type SqlValue = string | number | null | Uint8Array

// The part of SQLite the store needs: Cloudflare's `SqlStorage` and Node's
// `DatabaseSync` both fit behind it. Decision: its methods are plain, not
// Effects: they are the adapter over those synchronous third-party calls,
// and `transaction` runs its write inside the database's own synchronous
// transaction, where an Effect could not run. The store wraps every call in
// an Effect.
export interface Sql {
  readonly exec: (
    query: string,
    ...bindings: ReadonlyArray<SqlValue>
  ) => ReadonlyArray<Record<string, SqlValue>>
  readonly transaction: (write: () => void) => void
}

// One code's order book chunk for one minute, encoded.
export interface StoredChunk {
  readonly code: StockCode
  readonly minute: number
  readonly chunk: string
}

// What one flush writes.
export interface Flush {
  readonly trades: ReadonlyArray<RunningTrade>
  readonly candles: ReadonlyArray<StoredCandle>
  readonly livePrices: ReadonlyArray<LivePrice>
  readonly chunks: ReadonlyArray<StoredChunk>
  readonly ajaibBooks: ReadonlyArray<StoredAjaibBook>
  readonly facts: Readonly<Record<string, string>>
}

// Decision: a trade is one row keyed by its number as the INTEGER PRIMARY
// KEY, the table's rowid, with no secondary index, so each insert writes one
// row (spec apinrdw/kumora#138, "Storage and cost"). A day's numbers are far
// below 2^53, so they travel as plain numbers. Candles, last `liveprice`
// frames, book chunks and whole Ajaib books are keyed tables WITHOUT ROWID,
// replaced at most once a minute.
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
  `CREATE TABLE IF NOT EXISTS ajaib_books (
    code TEXT PRIMARY KEY,
    book TEXT NOT NULL
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

// Rows are the store's own writes, so they are read back without a decode.
const tradeOf = (row: Record<string, SqlValue>) =>
  Effect.sync((): RunningTrade => ({
    tradeNumber: TradeNumber.make(String(row.number)),
    time: DateTime.makeUnsafe(Number(row.time)),
    code: StockCode.make(String(row.code)),
    price: Number(row.price),
    lots: Number(row.lots),
    side: String(row.side) as RunningTrade["side"],
    board: String(row.board) as RunningTrade["board"],
    feeds: String(row.feeds).split(",") as RunningTrade["feeds"],
  }))

const storedCandleOf = (row: Record<string, SqlValue>) =>
  Effect.sync((): StoredCandle => ({
    code: StockCode.make(String(row.code)),
    minute: Number(row.minute),
    figures: {
      openOrder: BigInt(Number(row.open_order)),
      open: Number(row.open),
      closeOrder: BigInt(Number(row.close_order)),
      close: Number(row.close),
      closeTime: Number(row.close_time),
      high: Number(row.high),
      low: Number(row.low),
      volume: Number(row.volume),
      value: Number(row.value),
      frequency: Number(row.frequency),
    },
  }))

const candleOf = ({ code, minute, figures }: StoredCandle) =>
  Effect.succeed<Candle>({
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

const livePriceOf = (frame: SqlValue | undefined) =>
  Effect.sync((): LivePrice => {
    const { time, ...rest } = JSON.parse(String(frame)) as Omit<
      LivePrice,
      "time"
    > & { readonly time: number }
    return { ...rest, time: DateTime.makeUnsafe(time) }
  })

// Decision: a book chunk is stored gzipped (spec apinrdw/kumora#138, "Storage
// and cost"), with Node's zlib that the Worker's nodejs_compat flag provides:
// synchronous, so a flush stays one transaction.
const chunkOf = (blob: SqlValue | undefined) =>
  Effect.sync(() => new TextDecoder().decode(gunzipSync(blob as Uint8Array)))

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
          for (const { code, book } of flush.ajaibBooks)
            sql.exec(
              "INSERT OR REPLACE INTO ajaib_books VALUES (?, ?)",
              code,
              book
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
    const boundTrade = (bound: "min" | "max") =>
      Effect.sync(() => {
        const [row] = sql.exec(`SELECT ${bound}(number) AS number FROM trades`)
        return row === undefined || row.number === null
          ? undefined
          : Number(row.number)
      })

    const highestTrade = Effect.gen(function* () {
      const high = yield* boundTrade("max")
      return high === undefined
        ? undefined
        : TradeNumberValue.make(BigInt(high))
    })

    // How many trades the day stored so far: the index row's figure.
    const storedTrades = Effect.sync(() =>
      Number(sql.exec("SELECT count(*) AS count FROM trades")[0]?.count)
    )

    // The newest `limit` trades, ascending.
    const newestTrades = Effect.fnUntraced(function* (limit: number) {
      const trades = yield* Effect.forEach(
        sql.exec("SELECT * FROM trades ORDER BY number DESC LIMIT ?", limit),
        tradeOf
      )
      return trades.reverse()
    })

    // The trade with the lowest number at or above `number`.
    const firstFrom = (number: number) =>
      Effect.sync(
        () =>
          sql.exec(
            "SELECT number, time FROM trades WHERE number >= ? ORDER BY number LIMIT 1",
            number
          )[0]
      )

    // Decision: a trade number at or above every trade at or before an
    // instant is found by a binary search on the trade number, which IDX
    // hands out in matching order, so the table needs no index on time. The
    // stored times do not grow with the number exactly: Stockbit times a
    // trade to the millisecond, Ajaib and the backfill to the second, so a
    // trade's stored time runs at most TIME_SKEW_MS before the one before
    // it. The search therefore looks for the highest number whose time is
    // within the skew after the instant: every trade at or before the
    // instant is at or below it, and the query's time filter drops the rest.
    const highestWithin = Effect.fnUntraced(function* (cutoff: number) {
      const bound = cutoff + TIME_SKEW_MS
      let low = yield* boundTrade("min")
      let high = yield* boundTrade("max")
      if (low === undefined || high === undefined) return undefined
      let found: number | undefined
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const row = yield* firstFrom(middle)
        if (row === undefined || Number(row.number) > high) {
          high = middle - 1
          continue
        }
        if (Number(row.time) <= bound) {
          found = Number(row.number)
          low = found + 1
        } else high = middle - 1
      }
      return found
    })

    // The newest `limit` trades at or before `at`, ascending: SQLite walks
    // the primary key down from the search's number and skips the rows the
    // skew lets past it.
    const tradesAt = Effect.fnUntraced(function* (
      at: DateTime.Utc,
      limit: number
    ) {
      const cutoff = DateTime.toEpochMillis(at)
      const found = yield* highestWithin(cutoff)
      if (found === undefined) return []
      const trades = yield* Effect.forEach(
        sql.exec(
          "SELECT * FROM trades WHERE number <= ? AND time <= ? ORDER BY number DESC LIMIT ?",
          found,
          cutoff,
          limit
        ),
        tradeOf
      )
      return trades.reverse()
    })

    // The trades after `after` and at or before `through`, ascending. The
    // numbers start from a search two skews before `after`: every trade at
    // or below that number is at or before `after`, so none is missed, and
    // the time filter decides the rest.
    const tradesBetween = Effect.fnUntraced(function* (
      after: DateTime.Utc,
      through: DateTime.Utc
    ) {
      const from = DateTime.toEpochMillis(after)
      const to = DateTime.toEpochMillis(through)
      const last = yield* highestWithin(to)
      if (last === undefined) return []
      const first = (yield* highestWithin(from - 2 * TIME_SKEW_MS)) ?? 0
      return yield* Effect.forEach(
        sql.exec(
          "SELECT * FROM trades WHERE number > ? AND number <= ? AND time > ? AND time <= ? ORDER BY number",
          first,
          last,
          from,
          to
        ),
        tradeOf
      )
    })

    // One code's candle for one minute, with its trade orders.
    const storedCandle = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      const [row] = sql.exec(
        "SELECT * FROM candles WHERE code = ? AND minute = ?",
        code,
        minute
      )
      return row === undefined
        ? undefined
        : (yield* storedCandleOf(row)).figures
    })

    // One code's candles after `after`, every one when undefined, with their
    // trade orders, ascending by minute.
    const storedCandlesOf = (code: StockCode, after?: number) =>
      Effect.suspend(() =>
        Effect.forEach(
          sql.exec(
            "SELECT * FROM candles WHERE code = ? AND minute > ? ORDER BY minute",
            code,
            after ?? -1
          ),
          storedCandleOf
        )
      )

    // One code's candles, ascending by minute.
    const candlesOf = (code: StockCode) =>
      Effect.suspend(() =>
        Effect.forEach(
          sql.exec(
            "SELECT * FROM candles WHERE code = ? ORDER BY minute",
            code
          ),
          (row) => Effect.flatMap(storedCandleOf(row), candleOf)
        )
      )

    const livePrices = Effect.suspend(() =>
      Effect.forEach(sql.exec("SELECT frame FROM live_prices"), (row) =>
        livePriceOf(row.frame)
      )
    )

    const livePrice = Effect.fnUntraced(function* (code: StockCode) {
      const [row] = sql.exec(
        "SELECT frame FROM live_prices WHERE code = ?",
        code
      )
      return row === undefined ? undefined : yield* livePriceOf(row.frame)
    })

    // The chunk of `code` for the minute holding `minute`, or the latest
    // before it: the book in force then.
    const chunkAt = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      const [row] = sql.exec(
        "SELECT chunk FROM book_chunks WHERE code = ? AND minute <= ? ORDER BY minute DESC LIMIT 1",
        code,
        minute
      )
      return row === undefined ? undefined : yield* chunkOf(row.chunk)
    })

    // Every code's latest chunk: the books a restarted object starts from.
    const latestChunks = Effect.suspend(() =>
      Effect.forEach(
        sql.exec(
          `SELECT chunk FROM book_chunks AS b
           WHERE minute = (SELECT max(minute) FROM book_chunks WHERE code = b.code)`
        ),
        (row) => chunkOf(row.chunk)
      )
    )

    // Every code's whole Ajaib book: what a restarted object's deltas build
    // on.
    const ajaibBooks = Effect.sync(() =>
      sql
        .exec("SELECT code, book FROM ajaib_books")
        .map((row): StoredAjaibBook => ({
          code: StockCode.make(String(row.code)),
          book: String(row.book),
        }))
    )

    const fact = (key: string) =>
      Effect.sync(() => {
        const [row] = sql.exec("SELECT value FROM facts WHERE key = ?", key)
        return row === undefined ? undefined : String(row.value)
      })

    return {
      write,
      hasTrade,
      highestTrade,
      storedTrades,
      newestTrades,
      tradesAt,
      tradesBetween,
      storedCandle,
      storedCandlesOf,
      candlesOf,
      livePrices,
      livePrice,
      chunkAt,
      latestChunks,
      ajaibBooks,
      fact,
    }
  })
