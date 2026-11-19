// Where a trading day keeps what it recorded (spec apinrdw/kumora#138,
// "Storage and cost"): the trading-day Durable Object's SQLite database. The
// object hands its `ctx.storage.sql`; the tests hand Node's SQLite. Every
// write of a flush lands in one transaction, so a restart finds the trades,
// candles, footprints, last frames and book chunks of the same instant.
import { gunzipSync, gzipSync } from "node:zlib"

import {
  StockCode,
  BookEvent,
  TradeNumberValue,
  type Footprint,
  type RunningTrade,
  type Sweep,
  MAX_CODE_BOOK_EVENTS,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import type { DaySums, MinuteFigures, StoredBubbles } from "./bubble-book.ts"
import type { StoredBookChunk } from "./cold-books.ts"
import type {
  FootprintRow,
  StoredCandle,
  StoredFootprint,
  StoredSweeps,
} from "./candles.ts"
import { candleFrom } from "./candles.ts"
import { cellsFromText, cellsOut, cellsText } from "./footprint-cells.ts"
import {
  chunkSlices,
  endBookOf,
  heldChunkOf,
  slicesFromText,
  storedEndBook,
  type HeatRow,
} from "./heat-rows.ts"
import type { StoredAjaibBook } from "./order-books.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"
import { sweepsFromText, sweepsText } from "./sweep-rows.ts"
import { TRADE_CODES_FACT } from "./tape-chunks.ts"
import { makeTape } from "./tape.ts"

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
// Decision: the Staging cost check reads these from Workers Logs, a line a
// flush or, after the seal, a sweep brokers recompute, as the feed lag lines
// (apinrdw/kumora#231): no binding or route, and a restart loses at most
// one line's counts. See apinrdw/kumora#270, docs/runbooks/order-flow-cost.md.
// Each billed meter figure, and the database count it adds up.
const BILLED = {
  billedRowsWritten: "rowsWritten",
  billedMinuteRereadRows: "rowsRead",
  billedSweepBrokerReadRows: "rowsRead",
} as const

interface Meter {
  trades: number
  candles: number
  footprints: number
  bookChunks: number
  sessionBooks: number
  livePrices: number
  ajaibBooks: number
  facts: number
  minuteRereads: number
  // The sweep brokers rows (sweep-brokers.ts) replaced or deleted, and the
  // minutes their recomputes read back.
  sweepBrokers: number
  sweepBrokerMinutes: number
  bookEvents: number
  billedRowsWritten?: number
  billedMinuteRereadRows?: number
  billedSweepBrokerReadRows?: number
}

const emptyMeter = Effect.sync((): Meter => ({
  trades: 0,
  candles: 0,
  footprints: 0,
  bookChunks: 0,
  sessionBooks: 0,
  livePrices: 0,
  ajaibBooks: 0,
  facts: 0,
  minuteRereads: 0,
  sweepBrokers: 0,
  sweepBrokerMinutes: 0,
  bookEvents: 0,
}))

// One code's order book chunk for one minute, encoded.
export interface StoredChunk {
  readonly code: StockCode
  readonly minute: number
  readonly chunk: string
}

// One code's last book served in a session, encoded as a chunk that starts
// from it (session-books.ts).
export interface SessionBook {
  readonly code: StockCode
  readonly chunk: string
}

// What one flush writes.
export interface Flush {
  readonly trades: ReadonlyArray<RunningTrade>
  readonly candles: ReadonlyArray<StoredCandle>
  readonly footprints: ReadonlyArray<FootprintRow>
  readonly livePrices: ReadonlyArray<LivePrice>
  readonly chunks: ReadonlyArray<StoredChunk>
  // Each code's last book served in the session that just ended, as a book
  // chunk that starts from it: written only when a session ends.
  readonly sessionBooks?: ReadonlyArray<SessionBook>
  readonly ajaibBooks: ReadonlyArray<StoredAjaibBook>
  readonly facts: Readonly<Record<string, string>>
  // Further writes, run in the flush's transaction after its rows.
  readonly alsoWrites?: () => void
  // The book events found since the last flush that landed.
  readonly bookEvents?: ReadonlyArray<BookEvent>
}

// Decision: the trades are the tape's (tape.ts). The other tables are keyed
// WITHOUT ROWID, replaced at most once a minute. See spec apinrdw/kumora#138,
// "Storage and cost".
const SCHEMA = [
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
    buy_value REAL NOT NULL DEFAULT 0,
    sell_value REAL NOT NULL DEFAULT 0,
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
  // Each code's last book served in Sessions 1 or 2 (session-books.ts), as a
  // gzipped book chunk that starts from it. A day recorded before it holds
  // none.
  `CREATE TABLE IF NOT EXISTS session_books (
    code TEXT PRIMARY KEY,
    chunk BLOB NOT NULL
  ) WITHOUT ROWID`,
  // A stock's book heatmap slices for one minute (heat-rows.ts), which a
  // day recorded before heatmaps were worked out on read holds beside each
  // book chunk.
  // Decision: a new day still creates the table, empty, so old and new days
  // read the same way; the third spec of apinrdw/kumora#555 drops it.
  `CREATE TABLE IF NOT EXISTS heatmaps (
    code TEXT NOT NULL,
    minute INTEGER NOT NULL,
    slices TEXT NOT NULL,
    PRIMARY KEY (code, minute)
  ) WITHOUT ROWID`,
  // One book event (level-ledger.ts), its kind's own figures in `detail`.
  `CREATE TABLE IF NOT EXISTS book_events (
    code TEXT NOT NULL,
    time INTEGER NOT NULL,
    kind TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    lots REAL NOT NULL,
    orders INTEGER NOT NULL,
    detail TEXT NOT NULL,
    PRIMARY KEY (code, time, kind, side, price)
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

// Decision: a day store from before candles carried buy and sell value gains
// both columns last, as in SCHEMA, so the candles INSERT fits. Today's and an
// unsealed day's candles get them from the stored trades in that transaction:
// today's bubbles answer until midnight (`bubblesAnswer`). A sealed past day's
// keep 0: Market Bubbles is live only. See apinrdw/kumora#436.
const ADDED_CANDLE_COLUMNS = ["buy_value", "sell_value"]

// The keys of the facts table.
export const Fact = {
  sealed: "sealed",
  gaps: "gaps",
  feedDowns: "feed-downs",
  // The broker codes store's (broker-codes.ts): the day's N and Stockbit's
  // cross-check walk.
  brokerCodesN: "broker-codes-n",
  crossCheck: "cross-check",
  // Whether the day holds codes for every trade 1..N (broker-codes.ts,
  // `codesComplete`): `true` or `false`, none on a day no batch or seal
  // wrote it for.
  codesComplete: "codes-complete",
  // The one-off build of a day's order flow rows (order-flow-build.ts): the
  // last minute it wrote, then ORDER_FLOW_BUILT.
  orderFlowBuilt: "order-flow-built",
  // The one-off build of a day's sweep brokers rows (sweep-brokers.ts): the
  // last minute it wrote, then SWEEP_BROKERS_BUILT, each under
  // SWEEP_BROKERS_SHAPE.
  sweepBrokersBuilt: "sweep-brokers-built",
  // That the object recorded the day's book events (book-event-log.ts): a
  // day without it was recorded before them.
  bookEvents: "book-events",
  // Where the day's tape comes from (trading-day.ts): TapeSource's relay or
  // walk, none while unknown.
  tapeSource: "tape-source",
  // Whether the broker codes store's tape summary stands for the tape
  // (broker-codes.ts, `summarizeTape`): TAPE_SUMMARY_BUILT, none until then.
  tapeSummary: "tape-summary",
  // The day's broker totals build (broker-totals.ts): BROKER_TOTALS_DUE once
  // the sealed day is buildable, then the build version that wrote them.
  brokerTotals: "broker-totals",
  // Every code's value on the previous trading day (previous-values.ts),
  // as its object answered it, once a day.
  previousValues: "previous-values",
  // When each alarm duty is next due (wakes.ts): epoch millis, none once
  // done.
  sealWake: "seal-wake",
  buildWake: "build-wake",
  moveWake: "move-wake",
  // A sealed day's move to R2 (cold-days.ts, `MoveProgress`): where it
  // stopped, as JSON; none until it starts.
  move: "move",
  // The codes whose order books the day records (recorded-books.ts): a JSON
  // array; none on a day recorded before it, which records every code's.
  recordedBooks: "recorded-books",
  // The WIB date of the object's last usage line (trading-day.ts,
  // `usageLine`).
  usageLogged: "usage-logged",
  // A chunked tape's code list (tape-chunks.ts): a JSON array its records
  // index into.
  tradeCodes: TRADE_CODES_FACT,
} as const

export const TAPE_SUMMARY_BUILT = "built"

export const ORDER_FLOW_BUILT = "built"
// Decision: the build's progress and finished value both name the rows'
// shape, a new one whenever their content changes, so a day holding either
// under an older shape (`built`, a bare minute) counts as unbuilt and its
// next sweep brokers GET rebuilds every row from its first minute. See spec
// apinrdw/kumora#384, "Old days".
export const SWEEP_BROKERS_SHAPE = "split"
export const SWEEP_BROKERS_BUILT = `${SWEEP_BROKERS_SHAPE}:built`

// What the one-off build writes of one minute: every stock's footprint row,
// and the minute as its progress; a walked day's build writes its candles
// too.
export interface BuiltMinute {
  readonly minute: number
  readonly candles: ReadonlyArray<StoredCandle>
  readonly footprints: ReadonlyArray<FootprintRow>
}

// The footprint rows one statement of the restart's sweep read takes.
// Decision: `eachStoredSweeps` reads 500 rows a statement by the table's
// key. `Sql.exec` hands a statement's rows back whole, and the worst day's
// in one statement held 75 MiB against the spec's ~30 MB; paged, the read
// peaks at 12 MiB (sweep-alerts-memory.test.ts). See spec apinrdw/kumora#510.
const SWEEP_PAGE = 500

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
      buyValue: Number(row.buy_value),
      sellValue: Number(row.sell_value),
      frequency: Number(row.frequency),
    },
  }))

const candleOf = ({ code, minute, figures }: StoredCandle) =>
  candleFrom(code, minute, figures)

// A stored book event: its columns and its kind's own figures in `detail`,
// decoded as the wire's BookEvent. A row this code can't read is a defect.
const decodeDetail = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)
const decodeBookEvent = Schema.decodeUnknownEffect(BookEvent)
const bookEventOf = Effect.fnUntraced(function* (
  row: Record<string, SqlValue>
) {
  const detail = yield* decodeDetail(row.detail)
  return yield* decodeBookEvent({
    ...detail,
    kind: row.kind,
    code: row.code,
    at: row.time,
    side: row.side,
    price: row.price,
    lots: row.lots,
    orders: row.orders,
  })
}, Effect.orDie)

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

// `today` when the store holds today's WIB date.
export const makeDayStore = (
  sql: Sql,
  { today }: { readonly today: boolean }
) =>
  Effect.gen(function* () {
    for (const statement of SCHEMA) sql.exec(statement)
    const tape = makeTape(sql)
    const columns = new Set(
      sql.exec("PRAGMA table_info(candles)").map((row) => String(row.name))
    )
    const added = ADDED_CANDLE_COLUMNS.filter((column) => !columns.has(column))
    const sealed =
      sql.exec("SELECT 1 FROM facts WHERE key = ?", Fact.sealed).length > 0
    if (added.length > 0)
      sql.transaction(() => {
        for (const column of added)
          sql.exec(
            `ALTER TABLE candles ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`
          )
        if (today || !sealed) tape.rebuildCandleSides()
      })

    let meter = yield* emptyMeter
    // Runs `work`, adding the rows the database counted meanwhile to the
    // meter's billed `field`, when the database counts them.
    const metered = <A, E, R>(
      field: keyof typeof BILLED,
      work: Effect.Effect<A, E, R>
    ) =>
      Effect.gen(function* () {
        const before = sql.usage?.()
        const result = yield* work
        const after = sql.usage?.()
        if (before !== undefined && after !== undefined)
          meter[field] =
            (meter[field] ?? 0) + after[BILLED[field]] - before[BILLED[field]]
        return result
      })
    // Writes in one transaction, metering the rows it wrote.
    const meteredTransaction = (write: () => void) =>
      metered(
        "billedRowsWritten",
        Effect.sync(() => sql.transaction(write))
      )

    // The meter's counts since it was last taken.
    const takeMeter = Effect.gen(function* () {
      const taken = meter
      meter = yield* emptyMeter
      return taken
    })

    // What the database counted since the usage was last taken, and its
    // size; none when it counts nothing. The counts start when the object
    // wakes, so a restart's first take holds only its own.
    let usageTaken = { rowsRead: 0, rowsWritten: 0 }
    const takeUsage = Effect.sync(() => {
      const usage = sql.usage?.()
      if (usage === undefined) return undefined
      const taken = {
        rowsRead: usage.rowsRead - usageTaken.rowsRead,
        rowsWritten: usage.rowsWritten - usageTaken.rowsWritten,
        bytes: usage.bytes,
      }
      usageTaken = usage
      return taken
    })

    // Footprint rows are encoded before the transaction, where an
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
    const insertCandles = (candles: ReadonlyArray<StoredCandle>) => {
      for (const { code, minute, figures } of candles)
        sql.exec(
          "INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          figures.frequency,
          figures.buyValue,
          figures.sellValue
        )
    }
    const insertFact = (key: string, value: string) =>
      sql.exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)

    const write = Effect.fnUntraced(function* (flush: Flush) {
      const footprints = yield* footprintTexts(flush.footprints)
      yield* meteredTransaction(() => {
        tape.write(flush.trades)
        insertCandles(flush.candles)
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
        // Decision: each session's end writes one row per code whose book
        // was served in it, about 900 rows at the break and 900 at the
        // close, rather than a code's every chunk: a restart brings back
        // every code's book and readings from them, then from any newer
        // recorded chunk (trading-day.ts, `restoreLastFrames`).
        for (const { code, chunk } of flush.sessionBooks ?? [])
          sql.exec(
            "INSERT OR REPLACE INTO session_books VALUES (?, ?)",
            code,
            new Uint8Array(gzipSync(chunk))
          )
        for (const { code, book } of flush.ajaibBooks)
          sql.exec(
            "INSERT OR REPLACE INTO ajaib_books VALUES (?, ?)",
            code,
            book
          )
        for (const [key, value] of Object.entries(flush.facts))
          insertFact(key, value)
        for (const event of flush.bookEvents ?? []) {
          const { code, at, kind, side, price, lots, orders, ...detail } = event
          sql.exec(
            "INSERT OR REPLACE INTO book_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            code,
            DateTime.toEpochMillis(at),
            kind,
            side,
            price,
            lots,
            orders,
            JSON.stringify(detail)
          )
        }
        flush.alsoWrites?.()
      })
      meter.bookEvents += flush.bookEvents?.length ?? 0
      meter.trades += flush.trades.length
      meter.candles += flush.candles.length
      meter.footprints += flush.footprints.length
      meter.bookChunks += flush.chunks.length
      meter.sessionBooks += flush.sessionBooks?.length ?? 0
      meter.livePrices += flush.livePrices.length
      meter.ajaibBooks += flush.ajaibBooks.length
      meter.facts += Object.keys(flush.facts).length
    })

    // One minute of the one-off build, with its progress, in one
    // transaction: a build that dies reruns from the minute after the last
    // one that landed.
    const writeBuiltMinute = Effect.fnUntraced(function* (built: BuiltMinute) {
      const footprints = yield* footprintTexts(built.footprints)
      yield* meteredTransaction(() => {
        insertCandles(built.candles)
        insertFootprints(footprints)
        insertFact(Fact.orderFlowBuilt, String(built.minute))
      })
      meter.candles += built.candles.length
      meter.footprints += built.footprints.length
      meter.facts += 1
    })

    const markOrderFlowBuilt = Effect.sync(() =>
      insertFact(Fact.orderFlowBuilt, ORDER_FLOW_BUILT)
    )
    const markSweepBrokersBuilt = Effect.sync(() =>
      insertFact(Fact.sweepBrokersBuilt, SWEEP_BROKERS_BUILT)
    )
    const markBrokerTotals = (value: string) =>
      Effect.sync(() => insertFact(Fact.brokerTotals, value))
    // A fact written or dropped on its own, outside any flush's transaction.
    const setFact = (key: string, value: string | undefined) =>
      Effect.sync(() => {
        if (value === undefined)
          sql.exec("DELETE FROM facts WHERE key = ?", key)
        else insertFact(key, value)
      })

    // One minute of a sweep brokers recompute (sweep-brokers.ts), metering
    // the rows it read.
    const sweepBrokerMinute = <A, E, R>(recompute: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        meter.sweepBrokerMinutes += 1
        return metered("billedSweepBrokerReadRows", recompute)
      })

    // A sweep brokers write of `rows` rows, and `facts`, in one transaction.
    const writeSweepBrokers = (
      rows: number,
      facts: Readonly<Record<string, string>>,
      writeRows: () => void
    ) =>
      Effect.gen(function* () {
        yield* meteredTransaction(() => {
          writeRows()
          for (const [key, value] of Object.entries(facts))
            insertFact(key, value)
        })
        meter.sweepBrokers += rows
        meter.facts += Object.keys(facts).length
      })

    const highestTrade = Effect.sync(() => {
      const high = tape.highestNumber()
      return high === undefined
        ? undefined
        : TradeNumberValue.make(BigInt(high))
    })

    const { tradesBetween } = tape

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

    // Every stock's day totals and newest `minutes` candles, for the bubble
    // book a restart rebuilds (bubble-book.ts). An index's candles have no
    // footprint, so a stock is a code with one.
    // Decision: read once, at a live day's start: one pass over the candles
    // for the totals and one for the newest minutes, about 400,000 rows each
    // at a full day, not one read of the day's candles a build. See spec
    // apinrdw/kumora#427, "Where the day totals come from".
    const storedBubbles = (minutes: number) =>
      Effect.sync((): StoredBubbles => {
        const stocks = "code IN (SELECT code FROM footprints GROUP BY code)"
        const sums = (row: Record<string, SqlValue>): DaySums => ({
          value: Number(row.value),
          volume: Number(row.volume),
          frequency: Number(row.frequency),
          buyValue: Number(row.buy_value),
          sellValue: Number(row.sell_value),
        })
        const figures = (row: Record<string, SqlValue>): MinuteFigures => ({
          ...sums(row),
          close: Number(row.close),
        })
        return {
          days: sql
            .exec(
              `SELECT code, sum(value) AS value, sum(volume) AS volume,
                sum(frequency) AS frequency, sum(buy_value) AS buy_value,
                sum(sell_value) AS sell_value
               FROM candles WHERE ${stocks} GROUP BY code`
            )
            .map((row) => ({
              code: StockCode.make(String(row.code)),
              sums: sums(row),
            })),
          minutes: sql
            .exec(
              `SELECT * FROM (
                 SELECT code, minute, value, volume, frequency, buy_value,
                   sell_value, close,
                   row_number() OVER (PARTITION BY code ORDER BY minute DESC)
                     AS newest
                 FROM candles WHERE ${stocks}
               ) WHERE newest <= ?`,
              minutes
            )
            .map((row) => ({
              code: StockCode.make(String(row.code)),
              minute: Number(row.minute),
              figures: figures(row),
            })),
        }
      })

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

    // The first and last minute that can hold a stored trade, the tape's
    // (`minuteSpan`); none when the day stored none.
    const orderFlowMinutes = tape.minuteSpan

    // Every stock's regular-board trades in one minute, ascending by trade
    // number: one read of the whole market's minute.
    const minuteTrades = Effect.fnUntraced(function* (minute: number) {
      return (yield* tradesBetween(
        DateTime.makeUnsafe(minute - 1),
        DateTime.makeUnsafe(minute + MINUTE_MS - 1)
      )).filter((trade) => trade.board === "RG")
    })

    // The minutes the stored trades numbered `first` to `last` fall in,
    // ascending; none when it holds none of them.
    const minutesOfTrades = tape.minutesOf

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
      if (tape.highestNumber() !== undefined) return false
      return sql.exec("SELECT 1 FROM book_chunks LIMIT 1").length === 0
    })

    // One stock's regular-board trades in one minute, ascending by trade
    // number. The tape has no code index (tape.ts, tape-chunks.ts), so this
    // reads the whole market's minute; the book asks only when a late trade
    // lands in a stored minute (candles.ts, `slotSweeps`).
    const storedMinuteTrades = Effect.fnUntraced(function* (
      code: StockCode,
      minute: number
    ) {
      meter.minuteRereads += 1
      const trades = yield* metered(
        "billedMinuteRereadRows",
        minuteTrades(minute)
      )
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

    // Every stock's sweeps, a minute at a time, each handed to `each` as it
    // is read: a page of rows after the last one read, until a page comes
    // short, so the day's are never held at once.
    const eachStoredSweeps = Effect.fnUntraced(function* (
      each: (
        code: StockCode,
        sweeps: ReadonlyArray<Sweep>
      ) => Effect.Effect<void>
    ) {
      let code = ""
      let minute = 0
      while (true) {
        const rows = sql.exec(
          "SELECT code, minute, sweeps FROM footprints WHERE (code, minute) > (?, ?) ORDER BY code, minute LIMIT ?",
          code,
          minute,
          SWEEP_PAGE
        )
        for (const row of rows)
          yield* each(
            StockCode.make(String(row.code)),
            yield* sweepsFromText(String(row.sweeps))
          )
        const last = rows.at(-1)
        if (last === undefined || rows.length < SWEEP_PAGE) return
        code = String(last.code)
        minute = Number(last.minute)
      }
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

    // One code's newest MAX_CODE_BOOK_EVENTS stored book events, oldest
    // first.
    const bookEventsOf = (code: StockCode) =>
      Effect.map(
        Effect.forEach(
          sql.exec(
            "SELECT * FROM book_events WHERE code = ? ORDER BY time DESC LIMIT ?",
            code,
            MAX_CODE_BOOK_EVENTS
          ),
          bookEventOf
        ),
        (events) => events.reverse()
      )

    // The day's newest `limit` stored book events of every code, oldest
    // first.
    const newestBookEvents = (limit: number) =>
      Effect.map(
        Effect.forEach(
          sql.exec(
            "SELECT * FROM book_events ORDER BY time DESC LIMIT ?",
            limit
          ),
          bookEventOf
        ),
        (events) => events.reverse()
      )

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

    // One stock's book heatmap rows by minute, ascending, each with the book
    // its chunk ended with: its stored heatmap rows, then from the minute
    // after the last of them each stored chunk's slices, worked out on read.
    // Decision: a day stores no heatmap row, so a GET reads the code's book
    // chunks, about 273 rows, and runs the chunk close's own math on them
    // (heat-rows.ts, `chunkSlices`). A day recorded before holds a row beside
    // each chunk until the change shipped, and answers those. See spec
    // apinrdw/kumora#555, "Heatmaps worked out on read".
    const heatmapOf = Effect.fnUntraced(function* (code: StockCode) {
      const rows: Array<HeatRow> = []
      for (const row of sql.exec(
        "SELECT minute, slices FROM heatmaps WHERE code = ? ORDER BY minute",
        code
      )) {
        const minute = Number(row.minute)
        rows.push({
          minute,
          slices: yield* slicesFromText(minute, String(row.slices)),
          endBook: Effect.flatMap(chunkOfMinute(code, minute), storedEndBook),
        })
      }
      for (const row of sql.exec(
        "SELECT chunk FROM book_chunks WHERE code = ? AND minute > ? ORDER BY minute",
        code,
        rows.at(-1)?.minute ?? -1
      )) {
        const chunk = yield* heldChunkOf(yield* chunkOf(row.chunk))
        // The ending book is worked out now, so the row keeps one book, not
        // the chunk's frames: a busy code's 273 chunks of 250 ms frames held
        // about 220 MB, past the Worker's 128 MB (heatmap-memory.test.ts).
        rows.push({
          minute: chunk.minute,
          slices: yield* chunkSlices(chunk),
          endBook: Effect.succeed(yield* endBookOf(chunk)),
        })
      }
      return rows
    })

    // The codes a table keyed by (code, minute) holds rows of, ascending.
    // Decision: a seek per code down the primary key, not a DISTINCT scan:
    // about one row read a code, where the scan reads every row (about
    // 13 K book chunks, or every candle). See spec apinrdw/kumora#556,
    // "The move".
    const codesOf = (table: "candles" | "book_chunks" | "heatmaps") =>
      Effect.sync(() =>
        sql
          .exec(
            `WITH RECURSIVE held(code) AS (
               SELECT min(code) FROM ${table}
               UNION ALL
               SELECT (SELECT min(code) FROM ${table} WHERE code > held.code)
               FROM held WHERE held.code IS NOT NULL
             )
             SELECT code FROM held WHERE code IS NOT NULL`
          )
          .map((row) => StockCode.make(String(row.code)))
      )

    // The codes with a stored book chunk, and one code's chunks as stored,
    // ascending by minute: what a cold day's books are packed from
    // (cold-books.ts).
    const bookCodes = codesOf("book_chunks")

    // Every code the day holds a candle, book or heatmap of, ascending.
    const dayCodes = Effect.gen(function* () {
      const codes = new Set<StockCode>()
      for (const table of ["candles", "book_chunks", "heatmaps"] as const)
        for (const code of yield* codesOf(table)) codes.add(code)
      return [...codes].sort()
    })
    const storedChunksOf = (code: StockCode) =>
      Effect.sync(() =>
        sql
          .exec(
            "SELECT minute, chunk FROM book_chunks WHERE code = ? ORDER BY minute",
            code
          )
          .map((row): StoredBookChunk => ({
            minute: Number(row.minute),
            chunk: row.chunk as Uint8Array,
          }))
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

    // Every code's last book served in a session, by code, as the chunks
    // that start from them: with the latest chunks, the books a restarted
    // object starts from.
    const sessionBooks = Effect.suspend(() =>
      Effect.forEach(sql.exec("SELECT chunk FROM session_books"), (row) =>
        chunkOf(row.chunk)
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
      sweepBrokerMinute,
      writeSweepBrokers,
      markSweepBrokersBuilt,
      markBrokerTotals,
      setFact,
      orderFlowMinutes,
      minuteTrades,
      minutesOfTrades,
      chunkOfMinute,
      storedNothing,
      takeMeter,
      takeUsage,
      orderFlowStorage,
      tapeShape: tape.shape,
      hasTrade: tape.has,
      highestTrade,
      // How many trades the day stored so far.
      storedTrades: tape.count,
      newestTrades: tape.newest,
      tradesAt: tape.tradesAt,
      tradesBetween,
      storedCandle,
      storedCandlesOf,
      storedBubbles,
      candlesOf,
      storedFootprint,
      storedFootprintsOf,
      storedMinuteTrades,
      storedSweeps,
      storedSweepsOf,
      eachStoredSweeps,
      footprintsOf,
      livePrices,
      livePrice,
      chunkAt,
      bookCodes,
      dayCodes,
      storedChunksOf,
      heatmapOf,
      bookEventsOf,
      newestBookEvents,
      latestChunks,
      sessionBooks,
      ajaibBooks,
      fact,
    }
  })

export type DayStore = Effect.Success<ReturnType<typeof makeDayStore>>
