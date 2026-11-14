// Where a trading day keeps what it recorded (spec apinrdw/kumora#138,
// "Storage and cost"): the trading-day Durable Object's SQLite database. The
// object hands its `ctx.storage.sql`; the tests hand Node's SQLite. Every
// write of a flush lands in one transaction, so a restart finds the trades,
// candles, footprints, last frames and book chunks of the same instant.
import { gunzipSync, gzipSync } from "node:zlib"

import {
  StockCode,
  TradeNumber,
  TradeNumberValue,
  type Candle,
  type Footprint,
  type HeatSlice,
  type RunningTrade,
  type Sweep,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type {
  FootprintRow,
  StoredCandle,
  StoredFootprint,
  StoredSweeps,
} from "./candles.ts"
import { cellsFromText, cellsOut, cellsText } from "./footprint-cells.ts"
import { slicesFromText, slicesText } from "./heat-rows.ts"
import type { StoredAjaibBook } from "./order-books.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"
import { sweepsFromText, sweepsText } from "./sweep-rows.ts"

export type SqlValue = string | number | null | Uint8Array

// The part of SQLite the store needs: Cloudflare's `SqlStorage` and Node's
// `DatabaseSync` both fit behind it.
// Decision: its methods are plain, not Effects: they adapt those synchronous
// third-party calls, and `transaction` runs its write inside the database's
// own synchronous transaction, where an Effect could not run. The store wraps
// every call in an Effect. See apinrdw/kumora#159.
export interface Sql {
  readonly exec: (
    query: string,
    ...bindings: ReadonlyArray<SqlValue>
  ) => ReadonlyArray<Record<string, SqlValue>>
  readonly transaction: (write: () => void) => void
  // What the database counted so far, when it counts: the rows every
  // statement read and wrote, as Cloudflare bills them, and its size.
  readonly usage?: () => {
    readonly rowsRead: number
    readonly rowsWritten: number
    readonly bytes: number
  }
}

// What the store wrote since the meter was last taken, by table, and the
// late trades that read a stored minute back (candles.ts, `slotSweeps`).
// Billed figures come from the database's own count, when it keeps one.
// Decision: the Staging cost check reads these from Workers Logs, one line a
// flush, like the feed lag lines (apinrdw/kumora#231): no binding or route,
// and a restart loses at most one flush's counts. See ticket
// apinrdw/kumora#270 and docs/runbooks/order-flow-cost.md.
interface Meter {
  trades: number
  candles: number
  footprints: number
  heatmaps: number
  bookChunks: number
  livePrices: number
  ajaibBooks: number
  facts: number
  minuteRereads: number
  billedRowsWritten?: number
  billedMinuteRereadRows?: number
}

const emptyMeter = (): Meter => ({
  trades: 0,
  candles: 0,
  footprints: 0,
  heatmaps: 0,
  bookChunks: 0,
  livePrices: 0,
  ajaibBooks: 0,
  facts: 0,
  minuteRereads: 0,
})

// One code's order book chunk for one minute, encoded, and its book heatmap
// slices (heat-rows.ts).
export interface StoredChunk {
  readonly code: StockCode
  readonly minute: number
  readonly chunk: string
  readonly slices: ReadonlyArray<HeatSlice>
}

// What one flush writes.
export interface Flush {
  readonly trades: ReadonlyArray<RunningTrade>
  readonly candles: ReadonlyArray<StoredCandle>
  readonly footprints: ReadonlyArray<FootprintRow>
  readonly livePrices: ReadonlyArray<LivePrice>
  readonly chunks: ReadonlyArray<StoredChunk>
  readonly ajaibBooks: ReadonlyArray<StoredAjaibBook>
  readonly facts: Readonly<Record<string, string>>
}

// Decision: a trade is one row keyed by its number as the INTEGER PRIMARY
// KEY (the rowid; a day's numbers stay far below 2^53), with no secondary
// index, so each insert writes one row. The other tables are keyed WITHOUT
// ROWID, replaced at most once a minute. See spec apinrdw/kumora#138,
// "Storage and cost".
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
  // A stock's footprint (footprint-cells.ts) and sweeps (sweep-rows.ts) for
  // one minute, beside its candle.
  `CREATE TABLE IF NOT EXISTS footprints (
    code TEXT NOT NULL,
    minute INTEGER NOT NULL,
    cells TEXT NOT NULL,
    sweeps TEXT NOT NULL,
    last_trade INTEGER NOT NULL,
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
  // A stock's book heatmap slices for one minute (heat-rows.ts), written
  // with its book chunk.
  `CREATE TABLE IF NOT EXISTS heatmaps (
    code TEXT NOT NULL,
    minute INTEGER NOT NULL,
    slices TEXT NOT NULL,
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
  // The broker codes store's (broker-codes.ts): the day's N and Stockbit's
  // cross-check walk.
  brokerCodesN: "broker-codes-n",
  crossCheck: "cross-check",
  // The one-off build of a day's order flow rows (order-flow-build.ts): the
  // last minute it wrote, then ORDER_FLOW_BUILT.
  orderFlowBuilt: "order-flow-built",
} as const

export const ORDER_FLOW_BUILT = "built"

// What the one-off build writes of one minute: every stock's footprint row
// and every code's heatmap row, and the minute as its progress.
export interface BuiltMinute {
  readonly minute: number
  readonly footprints: ReadonlyArray<FootprintRow>
  readonly heatmaps: ReadonlyArray<{
    readonly code: StockCode
    readonly minute: number
    readonly slices: ReadonlyArray<HeatSlice>
  }>
}

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

    let meter = emptyMeter()
    // Writes in one transaction, adding the rows the database counted to
    // the meter.
    const meteredTransaction = (write: () => void) => {
      const before = sql.usage?.()
      sql.transaction(write)
      const after = sql.usage?.()
      if (before !== undefined && after !== undefined)
        meter.billedRowsWritten =
          (meter.billedRowsWritten ?? 0) +
          after.rowsWritten -
          before.rowsWritten
    }

    // The meter's counts since it was last taken.
    const takeMeter = Effect.sync(() => {
      const taken = meter
      meter = emptyMeter()
      return taken
    })

    // Footprint and heatmap rows are encoded before the transaction, where an
    // Effect can't run.
    const footprintTexts = Effect.fnUntraced(function* (
      rows: ReadonlyArray<FootprintRow>
    ) {
      const texts: Array<readonly [FootprintRow, string, string]> = []
      for (const row of rows)
        texts.push([
          row,
          yield* cellsText(row.cells),
          yield* sweepsText(row.sweeps),
        ])
      return texts
    })
    const heatmapTexts = Effect.fnUntraced(function* (
      rows: ReadonlyArray<Pick<StoredChunk, "code" | "minute" | "slices">>
    ) {
      const texts: Array<readonly [StockCode, number, string]> = []
      for (const { code, minute, slices } of rows)
        texts.push([code, minute, yield* slicesText(minute, slices)])
      return texts
    })
    const insertFootprints = (
      texts: ReadonlyArray<readonly [FootprintRow, string, string]>
    ) => {
      for (const [{ code, minute, lastTrade }, cells, sweeps] of texts)
        sql.exec(
          "INSERT OR REPLACE INTO footprints VALUES (?, ?, ?, ?, ?)",
          code,
          minute,
          cells,
          sweeps,
          Number(lastTrade)
        )
    }
    const insertHeatmaps = (
      texts: ReadonlyArray<readonly [StockCode, number, string]>
    ) => {
      for (const [code, minute, slices] of texts)
        sql.exec(
          "INSERT OR REPLACE INTO heatmaps VALUES (?, ?, ?)",
          code,
          minute,
          slices
        )
    }
    const insertFact = (key: string, value: string) =>
      sql.exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)

    const write = Effect.fnUntraced(function* (flush: Flush) {
      const footprints = yield* footprintTexts(flush.footprints)
      const heatmaps = yield* heatmapTexts(flush.chunks)
      yield* Effect.sync(() =>
        meteredTransaction(() => {
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
          insertFootprints(footprints)
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
          insertHeatmaps(heatmaps)
          for (const { code, book } of flush.ajaibBooks)
            sql.exec(
              "INSERT OR REPLACE INTO ajaib_books VALUES (?, ?)",
              code,
              book
            )
          for (const [key, value] of Object.entries(flush.facts))
            insertFact(key, value)
        })
      )
      meter.trades += flush.trades.length
      meter.candles += flush.candles.length
      meter.footprints += flush.footprints.length
      meter.heatmaps += flush.chunks.length
      meter.bookChunks += flush.chunks.length
      meter.livePrices += flush.livePrices.length
      meter.ajaibBooks += flush.ajaibBooks.length
      meter.facts += Object.keys(flush.facts).length
    })

    // One minute of the one-off build, with its progress, in one
    // transaction: a build that dies reruns from the minute after the last
    // one that landed.
    const writeBuiltMinute = Effect.fnUntraced(function* (built: BuiltMinute) {
      const footprints = yield* footprintTexts(built.footprints)
      const heatmaps = yield* heatmapTexts(built.heatmaps)
      yield* Effect.sync(() =>
        meteredTransaction(() => {
          insertFootprints(footprints)
          insertHeatmaps(heatmaps)
          insertFact(Fact.orderFlowBuilt, String(built.minute))
        })
      )
      meter.footprints += built.footprints.length
      meter.heatmaps += built.heatmaps.length
      meter.facts += 1
    })

    const markOrderFlowBuilt = Effect.sync(() =>
      insertFact(Fact.orderFlowBuilt, ORDER_FLOW_BUILT)
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

    // Decision: the trades up to an instant are bounded by a binary search on
    // the trade number, which IDX hands out in time order, so the table needs
    // no time index. Stored times can run up to TIME_SKEW_MS backwards, so the
    // search targets the instant plus the skew and the query's time filter
    // drops the rest. See apinrdw/kumora#157.
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

    // One stock's footprint for one minute.
    const storedFootprint = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      const [row] = sql.exec(
        "SELECT cells FROM footprints WHERE code = ? AND minute = ?",
        code,
        minute
      )
      return row === undefined
        ? undefined
        : yield* cellsFromText(String(row.cells))
    })

    // One stock's footprints, ascending by minute.
    const storedFootprintsOf = (code: StockCode) =>
      Effect.suspend(() =>
        Effect.forEach(
          sql.exec(
            "SELECT minute, cells FROM footprints WHERE code = ? ORDER BY minute",
            code
          ),
          Effect.fnUntraced(function* (row) {
            return {
              code,
              minute: Number(row.minute),
              cells: yield* cellsFromText(String(row.cells)),
            } satisfies StoredFootprint
          })
        )
      )

    // The first and last minute holding a stored trade or book chunk; none
    // when the day stored neither. The trades' come off the primary key's
    // ends, the chunks' from one read of the chunk keys.
    const orderFlowMinutes = Effect.gen(function* () {
      const minutes: Array<number> = []
      for (const bound of ["min", "max"] as const) {
        const number = yield* boundTrade(bound)
        if (number === undefined) continue
        const [row] = sql.exec(
          "SELECT time FROM trades WHERE number = ?",
          number
        )
        minutes.push(Math.floor(Number(row?.time) / MINUTE_MS) * MINUTE_MS)
      }
      const chunks = new Map<number, Array<StockCode>>()
      for (const row of sql.exec("SELECT code, minute FROM book_chunks")) {
        const minute = Number(row.minute)
        const codes = chunks.get(minute) ?? []
        codes.push(StockCode.make(String(row.code)))
        chunks.set(minute, codes)
        minutes.push(minute)
      }
      return minutes.length === 0
        ? undefined
        : {
            first: Math.min(...minutes),
            last: Math.max(...minutes),
            chunks: chunks as ReadonlyMap<number, ReadonlyArray<StockCode>>,
          }
    })

    // Every stock's regular-board trades in one minute, ascending by trade
    // number: one read of the whole market's minute.
    const minuteTrades = Effect.fnUntraced(function* (minute: number) {
      return (yield* tradesBetween(
        DateTime.makeUnsafe(minute - 1),
        DateTime.makeUnsafe(minute + MINUTE_MS - 1)
      )).filter((trade) => trade.board === "RG")
    })

    // One code's stored book chunk for exactly `minute`, as stored.
    const chunkOfMinute = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      const [row] = sql.exec(
        "SELECT chunk FROM book_chunks WHERE code = ? AND minute = ?",
        code,
        minute
      )
      return row === undefined ? undefined : yield* chunkOf(row.chunk)
    })

    // Whether the day stored neither a trade nor a book chunk.
    const storedNothing = Effect.gen(function* () {
      if ((yield* boundTrade("max")) !== undefined) return false
      return sql.exec("SELECT 1 FROM book_chunks LIMIT 1").length === 0
    })

    // One stock's regular-board trades in one minute, ascending by trade
    // number. The trades table has no code index (the Decision on SCHEMA), so
    // this reads the whole market's minute; the book asks only when a late
    // trade lands in a stored minute (candles.ts, `slotSweeps`).
    const storedMinuteTrades = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      meter.minuteRereads += 1
      const before = sql.usage?.()
      const trades = yield* minuteTrades(minute)
      const after = sql.usage?.()
      if (before !== undefined && after !== undefined)
        meter.billedMinuteRereadRows =
          (meter.billedMinuteRereadRows ?? 0) + after.rowsRead - before.rowsRead
      return trades.filter((trade) => trade.code === code)
    })

    // How many order flow rows the day holds, their payload bytes, and the
    // whole database's bytes when the database counts them.
    const orderFlowStorage = Effect.sync(() => {
      const [footprints] = sql.exec(
        "SELECT count(*) AS rows, coalesce(sum(length(cells) + length(sweeps)), 0) AS bytes FROM footprints"
      )
      const [heatmaps] = sql.exec(
        "SELECT count(*) AS rows, coalesce(sum(length(slices)), 0) AS bytes FROM heatmaps"
      )
      const bytes = sql.usage?.().bytes
      return {
        footprintRows: Number(footprints?.rows),
        footprintBytes: Number(footprints?.bytes),
        heatmapRows: Number(heatmaps?.rows),
        heatmapBytes: Number(heatmaps?.bytes),
        ...(bytes === undefined ? {} : { databaseBytes: bytes }),
      }
    })

    // One stock's sweeps for one minute, with the highest trade number they
    // were grouped from.
    const storedSweeps = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      const [row] = sql.exec(
        "SELECT sweeps, last_trade FROM footprints WHERE code = ? AND minute = ?",
        code,
        minute
      )
      return row === undefined
        ? undefined
        : ({
            sweeps: yield* sweepsFromText(String(row.sweeps)),
            lastTrade: BigInt(Number(row.last_trade)),
          } satisfies StoredSweeps)
    })

    // One stock's sweeps by minute, ascending.
    const storedSweepsOf = Effect.fnUntraced(function* (code: StockCode) {
      const minutes = new Map<number, ReadonlyArray<Sweep>>()
      for (const row of sql.exec(
        "SELECT minute, sweeps FROM footprints WHERE code = ? ORDER BY minute",
        code
      ))
        minutes.set(
          Number(row.minute),
          yield* sweepsFromText(String(row.sweeps))
        )
      return minutes
    })

    // One stock's footprints as viewers get them, ascending by minute.
    const footprintsOf = Effect.fnUntraced(function* (code: StockCode) {
      const footprints: Array<Footprint> = []
      for (const stored of yield* storedFootprintsOf(code))
        footprints.push({
          code,
          minute: DateTime.makeUnsafe(stored.minute),
          cells: yield* cellsOut(stored.cells),
        })
      return footprints
    })

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

    // One stock's stored book heatmap slices by minute, ascending.
    const heatmapOf = (code: StockCode) =>
      Effect.suspend(() =>
        Effect.forEach(
          sql.exec(
            "SELECT minute, slices FROM heatmaps WHERE code = ? ORDER BY minute",
            code
          ),
          Effect.fnUntraced(function* (row) {
            const minute = Number(row.minute)
            return {
              minute,
              slices: yield* slicesFromText(minute, String(row.slices)),
            }
          })
        )
      )

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
      writeBuiltMinute,
      markOrderFlowBuilt,
      orderFlowMinutes,
      minuteTrades,
      chunkOfMinute,
      storedNothing,
      takeMeter,
      orderFlowStorage,
      hasTrade,
      highestTrade,
      storedTrades,
      newestTrades,
      tradesAt,
      tradesBetween,
      storedCandle,
      storedCandlesOf,
      candlesOf,
      storedFootprint,
      storedFootprintsOf,
      storedMinuteTrades,
      storedSweeps,
      storedSweepsOf,
      footprintsOf,
      livePrices,
      livePrice,
      chunkAt,
      heatmapOf,
      latestChunks,
      ajaibBooks,
      fact,
    }
  })
