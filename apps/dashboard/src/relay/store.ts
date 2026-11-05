// The object's SQL. Every call is synchronous, so a batch's rows still commit
// together while the caller has no `await` between them.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { TapeCoverage, Trade, TradeSource } from "@/domain/trade"

import { REGULAR_BOARD } from "./exchange"
import type { LastRg, LiveTotals } from "./quote"
import { WIB_MS } from "./trading-day"
import { whaleStore } from "./whale-store"

const CREATE_TAPE = `CREATE TABLE IF NOT EXISTS tape (
  symbol TEXT NOT NULL, seq INTEGER NOT NULL, day TEXT NOT NULL, received_at TEXT NOT NULL,
  last_number INTEGER NOT NULL, n INTEGER NOT NULL, trades TEXT NOT NULL,
  PRIMARY KEY (symbol, seq)) WITHOUT ROWID`

const CREATE_REST = [
  `CREATE TABLE IF NOT EXISTS symbol_state (
    symbol TEXT PRIMARY KEY, day TEXT NOT NULL, last_number INTEGER NOT NULL, last_seq INTEGER NOT NULL,
    last_received_at TEXT NOT NULL, trades INTEGER NOT NULL,
    last_rg_price REAL, last_rg_change REAL, last_rg_received_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS live_quote (
    symbol TEXT PRIMARY KEY, day TEXT NOT NULL, prev REAL, open REAL, high REAL, low REAL, avg REAL,
    volume REAL, value REAL, freq REAL, source_at TEXT, as_of TEXT NOT NULL, written_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS coverage (
    day TEXT NOT NULL, at TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (day, at))`,
]

export type RelayStore = ReturnType<typeof relayStore>

/** A `live_quote` row: the quote's totals, and the write that the 30 s throttle counts from. */
export type StoredQuote = {
  readonly totals: LiveTotals
  readonly writtenAt: number
}

type RgColumns = {
  last_rg_price: number | null
  last_rg_change: number | null
  last_rg_received_at: IsoDateTime | null
}

/** The newest RG trade a `symbol_state` row remembers, if it has seen one. */
export const lastRgOf = (row: RgColumns): LastRg | null =>
  row.last_rg_price === null || row.last_rg_received_at === null
    ? null
    : {
        price: row.last_rg_price,
        change: row.last_rg_change ?? 0,
        receivedAt: row.last_rg_received_at,
      }

export const relayStore = (sql: SqlStorage) => {
  const whales = whaleStore(sql)
  const rows = (query: string, ...params: Array<string | number>) =>
    sql
      .exec<{ trades: string }>(query, ...params)
      .toArray()
      .map((r) => JSON.parse(r.trades) as Array<Trade>)

  return {
    ...whales,

    create() {
      sql.exec(CREATE_TAPE)
      for (const create of CREATE_REST) sql.exec(create)
      whales.createWhaleTables()
    },

    /** At most about 850 rows. `load()` reads only this: it must not scan `tape`. */
    symbolStates: () =>
      sql.exec<
        RgColumns & {
          symbol: Symbol
          day: string
          last_number: number
          last_seq: number
          last_received_at: IsoDateTime
          trades: number
        }
      >(
        "SELECT symbol, day, last_number, last_seq, last_received_at, trades, last_rg_price, last_rg_change, last_rg_received_at FROM symbol_state"
      ),

    /** The newest `limit` rows after `since`, oldest first. */
    missed: (symbol: Symbol, since: number, limit: number) =>
      rows(
        "SELECT trades FROM (SELECT seq, trades FROM tape WHERE symbol = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        symbol,
        since,
        limit
      ).flat(),

    /** Newest first, at most `limit`. */
    newest: (symbol: Symbol, limit: number) =>
      rows(
        "SELECT trades FROM tape WHERE symbol = ? ORDER BY seq DESC LIMIT ?",
        symbol,
        limit
      )
        .flatMap((batch) => [...batch].reverse())
        .slice(0, limit),

    /** The session's off-board trades, newest first, at most `limit`. */
    newestOffBoard(symbol: Symbol, limit: number): Array<Trade> {
      const found: Array<Trade> = []
      for (const row of sql.exec<{ trades: string }>(
        "SELECT trades FROM tape WHERE symbol = ? ORDER BY seq DESC",
        symbol
      )) {
        const batch = JSON.parse(row.trades) as Array<Trade>
        for (const trade of batch.reverse()) {
          if (trade.board === REGULAR_BOARD) continue
          found.push(trade)
          if (found.length === limit) return found
        }
      }
      return found
    },

    /** The symbol's whole tape, one batch at a time, so a fold holds one batch's rows at most. */
    *batches(symbol: Symbol): Generator<ReadonlyArray<Trade>> {
      for (const row of sql.exec<{ trades: string }>(
        "SELECT trades FROM tape WHERE symbol = ? ORDER BY seq",
        symbol
      ))
        yield JSON.parse(row.trades) as Array<Trade>
    },

    /** One symbol's slice of a batch: its `tape` row and its `symbol_state`. */
    appendBatch(
      symbol: Symbol,
      seq: number,
      day: string,
      receivedAt: IsoDateTime,
      trades: ReadonlyArray<Trade>,
      rg: LastRg | null
    ) {
      const lastNumber = trades.at(-1)?.tradeNumber ?? 0
      sql.exec(
        "INSERT INTO tape (symbol, seq, day, received_at, last_number, n, trades) VALUES (?, ?, ?, ?, ?, ?, ?)",
        symbol,
        seq,
        day,
        receivedAt,
        lastNumber,
        trades.length,
        JSON.stringify(trades)
      )
      sql.exec(
        `INSERT INTO symbol_state (symbol, day, last_number, last_seq, last_received_at, trades, last_rg_price, last_rg_change, last_rg_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET
           day = excluded.day, last_number = excluded.last_number, last_seq = excluded.last_seq,
           last_received_at = excluded.last_received_at, trades = trades + excluded.trades,
           last_rg_price = COALESCE(excluded.last_rg_price, last_rg_price),
           last_rg_change = COALESCE(excluded.last_rg_change, last_rg_change),
           last_rg_received_at = COALESCE(excluded.last_rg_received_at, last_rg_received_at)`,
        symbol,
        day,
        lastNumber,
        seq,
        receivedAt,
        trades.length,
        rg?.price ?? null,
        rg?.change ?? null,
        rg?.receivedAt ?? null
      )
    },

    /** Drops the table rather than deleting by row, which would bill rows written. */
    clearDay(day: string) {
      sql.exec("DROP TABLE tape")
      sql.exec(CREATE_TAPE)
      sql.exec("DELETE FROM symbol_state")
      sql.exec("DELETE FROM live_quote")
      // Source changes before the day's first trade already belong to the new day. The
      // source the day began with stays, at its first instant, or a day with no change reads uncovered.
      const [began] = sql
        .exec<{ source: TradeSource }>(
          "SELECT source FROM coverage WHERE day < ? ORDER BY at DESC LIMIT 1",
          day
        )
        .toArray()
      sql.exec("DELETE FROM coverage WHERE day < ?", day)
      if (began)
        sql.exec(
          "INSERT OR IGNORE INTO coverage (day, at, source) VALUES (?, ?, ?)",
          day,
          new Date(Date.parse(day) - WIB_MS).toISOString(),
          began.source
        )
      whales.dropDay()
    },

    /** A second change in the same millisecond replaces the first: only the last one held. */
    addCoverage(day: string, at: string, source: TradeSource) {
      sql.exec(
        "INSERT OR REPLACE INTO coverage (day, at, source) VALUES (?, ?, ?)",
        day,
        at,
        source
      )
    },

    coverage: () =>
      sql
        .exec<TapeCoverage>("SELECT at, source FROM coverage ORDER BY at")
        .toArray(),

    storedQuote(symbol: Symbol): StoredQuote | null {
      const [row] = sql
        .exec<{
          day: string
          prev: number | null
          open: number | null
          high: number | null
          low: number | null
          avg: number | null
          volume: number | null
          value: number | null
          freq: number | null
          source_at: string | null
          as_of: IsoDateTime
          written_at: number
        }>("SELECT * FROM live_quote WHERE symbol = ?", symbol)
        .toArray()
      if (!row) return null
      const {
        source_at: sourceAt,
        as_of: asOf,
        written_at: writtenAt,
        ...figures
      } = row
      return { totals: { ...figures, sourceAt, asOf }, writtenAt }
    },

    writeQuote(symbol: Symbol, { totals, writtenAt }: StoredQuote) {
      const {
        day,
        prev,
        open,
        high,
        low,
        avg,
        volume,
        value,
        freq,
        sourceAt,
        asOf,
      } = totals
      sql.exec(
        `INSERT OR REPLACE INTO live_quote (symbol, day, prev, open, high, low, avg, volume, value, freq, source_at, as_of, written_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        symbol,
        day,
        prev,
        open,
        high,
        low,
        avg,
        volume,
        value,
        freq,
        sourceAt,
        asOf,
        writtenAt
      )
    },
  }
}
