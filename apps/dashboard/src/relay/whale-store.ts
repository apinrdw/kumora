// The whale tables, spread into `relayStore`. Synchronous like the rest of it, so a
// batch's rows commit together with its `tape` row.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type {
  LeaderboardEntry,
  Sweep,
  SweepCursor,
  ThresholdPrior,
  Trade,
  Wall,
} from "@/domain/trade"

import { bucketsFromBytes, sketchBytes } from "./whale"
import type { Priors, Sketch } from "./whale"

/** At most two sessions. last_number: the last trade of the last order inserted. */
const CREATE_SKETCHES = `CREATE TABLE IF NOT EXISTS sketches (
  symbol TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, last_number INTEGER NOT NULL,
  buckets BLOB NOT NULL, PRIMARY KEY (symbol, day)) WITHOUT ROWID`

const CREATE_SWEEPS = `CREATE TABLE IF NOT EXISTS sweeps (
  day TEXT NOT NULL, symbol TEXT NOT NULL, first_number INTEGER NOT NULL, last_number INTEGER NOT NULL,
  side TEXT NOT NULL, board TEXT NOT NULL, traded_at TEXT NOT NULL, lots REAL NOT NULL, value REAL NOT NULL,
  freq INTEGER NOT NULL, price_low REAL NOT NULL, price_high REAL NOT NULL, threshold REAL NOT NULL,
  warming_up INTEGER NOT NULL, prior TEXT NOT NULL, announced_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  closed_at TEXT, closed_by TEXT, seq INTEGER NOT NULL,
  PRIMARY KEY (day, symbol, first_number)) WITHOUT ROWID`

/** What the market's newest-first reads walk, and the cursor of `earlier`. */
const CREATE_SWEEPS_INDEX =
  "CREATE INDEX IF NOT EXISTS sweeps_announced ON sweeps (day, announced_at)"

const CREATE_WALLS = `CREATE TABLE IF NOT EXISTS walls (
  day TEXT NOT NULL, symbol TEXT NOT NULL, first_order_number TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
  member_order_numbers TEXT NOT NULL, hits_seen INTEGER NOT NULL, lots_matched REAL NOT NULL, threshold REAL NOT NULL,
  warming_up INTEGER NOT NULL, prior TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  closed_at TEXT, closed_by TEXT, seq INTEGER NOT NULL,
  PRIMARY KEY (day, symbol, first_order_number)) WITHOUT ROWID`

/** The watchlists' symbols, replaced whole by the dashboard. */
const CREATE_WALL_SYMBOLS =
  "CREATE TABLE IF NOT EXISTS wall_symbols (symbol TEXT PRIMARY KEY) WITHOUT ROWID"

type SweepRow = {
  day: string
  symbol: Symbol
  first_number: number
  last_number: number
  side: Sweep["side"]
  board: string
  traded_at: IsoDateTime
  lots: number
  value: number
  freq: number
  price_low: number
  price_high: number
  threshold: number
  warming_up: number
  prior: ThresholdPrior
  announced_at: IsoDateTime
  updated_at: IsoDateTime
  closed_at: IsoDateTime | null
  closed_by: Sweep["closedBy"]
  seq: number
}

const toSweep = (row: SweepRow): Sweep => ({
  day: row.day,
  symbol: row.symbol,
  firstNumber: row.first_number,
  lastNumber: row.last_number,
  side: row.side,
  board: row.board,
  tradedAt: row.traded_at,
  lots: row.lots,
  value: row.value,
  freq: row.freq,
  priceLow: row.price_low,
  priceHigh: row.price_high,
  threshold: row.threshold,
  warmingUp: row.warming_up === 1,
  prior: row.prior,
  open: row.closed_at === null,
  closedBy: row.closed_by,
  announcedAt: row.announced_at,
  updatedAt: row.updated_at,
  seq: row.seq,
})

type WallRow = {
  day: string
  symbol: Symbol
  first_order_number: string
  side: Wall["side"]
  price: number
  /** A JSON array of strings: each exceeds 2^53. */
  member_order_numbers: string
  hits_seen: number
  lots_matched: number
  threshold: number
  warming_up: number
  prior: ThresholdPrior
  first_seen: IsoDateTime
  last_seen: IsoDateTime
  closed_at: IsoDateTime | null
  closed_by: Wall["closedBy"]
  seq: number
}

const toWall = (row: WallRow): Wall => ({
  day: row.day,
  symbol: row.symbol,
  side: row.side,
  price: row.price,
  firstOrderNumber: row.first_order_number,
  memberOrderNumbers: JSON.parse(row.member_order_numbers) as Array<string>,
  hitsSeen: row.hits_seen,
  lotsMatched: row.lots_matched,
  threshold: row.threshold,
  warmingUp: row.warming_up === 1,
  prior: row.prior,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  seq: row.seq,
})

const WALLS_NEWEST_FIRST = "ORDER BY first_seen DESC, first_order_number DESC"

const SWEEPS_NEWEST_FIRST = "ORDER BY announced_at DESC, first_number DESC"

/**
 * The market's rows and order, which is also the cursor of `sweepsEarlier`. Named, because
 * the planner takes the primary key on `day` and then sorts the whole day on every read.
 */
const MARKET_SWEEPS = "SELECT * FROM sweeps INDEXED BY sweeps_announced"
/** The relay's half of `newestFirst` in `features/radar/whales.ts`: `earlier`'s cursor needs both to agree. */
const MARKET_NEWEST_FIRST = "ORDER BY announced_at DESC, symbol, first_number"
/** The row holding a session's market-wide sketch, the sum of all symbols. */
export const MARKET_SKETCH = "*"

type SketchRow = {
  symbol: Symbol | typeof MARKET_SKETCH
  n: number
  last_number: number
  buckets: ArrayBuffer
}

const toSketch = (row: SketchRow): Sketch => ({
  buckets: bucketsFromBytes(row.buckets),
  n: row.n,
  lastNumber: row.last_number,
})

const toSession = (rows: ReadonlyArray<SketchRow>): Priors => {
  const own = new Map<Symbol, Sketch>()
  let market: Sketch | null = null
  for (const row of rows)
    if (row.symbol === MARKET_SKETCH) market = toSketch(row)
    else own.set(row.symbol, toSketch(row))
  return { own, market }
}

export const whaleStore = (sql: SqlStorage) => ({
  createWhaleTables() {
    sql.exec(CREATE_SKETCHES)
    sql.exec(CREATE_SWEEPS)
    sql.exec(CREATE_SWEEPS_INDEX)
    sql.exec(CREATE_WALLS)
    sql.exec(CREATE_WALL_SYMBOLS)
  },

  /** Drops rather than deletes, which would bill a row written per row. `wall_symbols` stays. */
  dropDay() {
    sql.exec("DROP TABLE sweeps")
    sql.exec("DROP TABLE walls")
    sql.exec(CREATE_SWEEPS)
    sql.exec(CREATE_SWEEPS_INDEX)
    sql.exec(CREATE_WALLS)
  },

  /** No await in here, so the replacement commits whole. */
  replaceWallSymbols(symbols: ReadonlyArray<Symbol>) {
    sql.exec("DELETE FROM wall_symbols")
    for (const symbol of new Set(symbols))
      sql.exec("INSERT INTO wall_symbols (symbol) VALUES (?)", symbol)
  },

  /** In key order, so a restart reads the list a replacement made. */
  wallSymbols(): Array<Symbol> {
    return sql
      .exec<{ symbol: Symbol }>("SELECT symbol FROM wall_symbols")
      .toArray()
      .map((row) => row.symbol)
  },

  /** Lands on the row's key, so nothing is announced twice. Says whether the row is new. */
  upsertSweep(sweep: Sweep): boolean {
    const known = sql
      .exec(
        "SELECT 1 FROM sweeps WHERE day = ? AND symbol = ? AND first_number = ?",
        sweep.day,
        sweep.symbol,
        sweep.firstNumber
      )
      .toArray()
    sql.exec(
      `INSERT OR REPLACE INTO sweeps (day, symbol, first_number, last_number, side, board, traded_at, lots, value, freq,
         price_low, price_high, threshold, warming_up, prior, announced_at, updated_at, closed_at, closed_by, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sweep.day,
      sweep.symbol,
      sweep.firstNumber,
      sweep.lastNumber,
      sweep.side,
      sweep.board,
      sweep.tradedAt,
      sweep.lots,
      sweep.value,
      sweep.freq,
      sweep.priceLow,
      sweep.priceHigh,
      sweep.threshold,
      sweep.warmingUp ? 1 : 0,
      sweep.prior,
      sweep.announcedAt,
      sweep.updatedAt,
      sweep.open ? null : sweep.updatedAt,
      sweep.closedBy,
      sweep.seq
    )
    return known.length === 0
  },

  /** One symbol's day, newest first. */
  sweepsOf: (day: string, symbol: Symbol) =>
    sql
      .exec<SweepRow>(
        `SELECT * FROM sweeps WHERE day = ? AND symbol = ? ${SWEEPS_NEWEST_FIRST}`,
        day,
        symbol
      )
      .toArray()
      .map(toSweep),

  /** `>=`: an idle close changes a row without bumping `seq`, and a repeat upserts harmlessly. */
  sweepsSince: (day: string, symbol: Symbol, since: number, limit: number) =>
    sql
      .exec<SweepRow>(
        `SELECT * FROM sweeps WHERE day = ? AND symbol = ? AND seq >= ? ${SWEEPS_NEWEST_FIRST} LIMIT ?`,
        day,
        symbol,
        since,
        limit
      )
      .toArray()
      .map(toSweep),

  newestSweeps: (day: string, limit: number) =>
    sql
      .exec<SweepRow>(
        `${MARKET_SWEEPS} WHERE day = ? ${MARKET_NEWEST_FIRST} LIMIT ?`,
        day,
        limit
      )
      .toArray()
      .map(toSweep),

  /** The market's rows at `since` or later: `>=`, as for one symbol. */
  marketSweepsSince: (day: string, since: number, limit: number) =>
    sql
      .exec<SweepRow>(
        `${MARKET_SWEEPS} WHERE day = ? AND seq >= ? ${MARKET_NEWEST_FIRST} LIMIT ?`,
        day,
        since,
        limit
      )
      .toArray()
      .map(toSweep),

  /** The rows after the cursor. Its own day, so a cleared one comes back empty. */
  sweepsEarlier: (
    { day, announcedAt, symbol, firstNumber }: SweepCursor,
    limit: number
  ) =>
    sql
      .exec<SweepRow>(
        `${MARKET_SWEEPS} WHERE day = ? AND announced_at <= ?
           AND (announced_at < ? OR (symbol, first_number) > (?, ?))
         ${MARKET_NEWEST_FIRST} LIMIT ?`,
        day,
        announcedAt,
        announcedAt,
        symbol,
        firstNumber,
        limit
      )
      .toArray()
      .map(toSweep),

  /** Totals over every row of the day, which a page of them could not give. */
  leaderboard: (day: string): Array<LeaderboardEntry> =>
    sql
      .exec<{ symbol: Symbol; buy_value: number; sell_value: number }>(
        `SELECT symbol,
           SUM(CASE WHEN side = 'buy' THEN value ELSE 0 END) AS buy_value,
           SUM(CASE WHEN side = 'sell' THEN value ELSE 0 END) AS sell_value
         FROM sweeps WHERE day = ? GROUP BY symbol
         ORDER BY buy_value + sell_value DESC, symbol`,
        day
      )
      .toArray()
      .map((row) => ({
        symbol: row.symbol,
        buyValue: row.buy_value,
        sellValue: row.sell_value,
      })),

  sweepCount: (day: string) =>
    sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sweeps WHERE day = ?",
        day
      )
      .toArray()[0]?.n ?? 0,

  upsertSketch(
    symbol: Symbol | typeof MARKET_SKETCH,
    day: string,
    sketch: Sketch
  ) {
    sql.exec(
      "INSERT OR REPLACE INTO sketches (symbol, day, n, last_number, buckets) VALUES (?, ?, ?, ?, ?)",
      symbol,
      day,
      sketch.n,
      sketch.lastNumber,
      sketchBytes(sketch)
    )
  },

  sessionSketches: (day: string) =>
    toSession(
      sql.exec<SketchRow>("SELECT * FROM sketches WHERE day = ?", day).toArray()
    ),

  /** The most recent session before `day` that has rows, whichever day that was. */
  priorSketches: (day: string) =>
    toSession(
      sql
        .exec<SketchRow>(
          "SELECT * FROM sketches WHERE day = (SELECT MAX(day) FROM sketches WHERE day < ?)",
          day
        )
        .toArray()
    ),

  /** Keeps the newest session with rows, which is the next one's prior. */
  deleteOlderSketches() {
    sql.exec("DELETE FROM sketches WHERE day < (SELECT MAX(day) FROM sketches)")
  },

  /** By `symbol` and a range of `seq`: `tape`'s key starts with `symbol`, so `seq` alone scans. */
  tapeFrom: (symbol: Symbol, from: number) =>
    sql
      .exec<{ seq: number; received_at: IsoDateTime; trades: string }>(
        "SELECT seq, received_at, trades FROM tape WHERE symbol = ? AND seq >= ? ORDER BY seq",
        symbol,
        from
      )
      .toArray()
      .map(({ seq, received_at: receivedAt, trades }) => ({
        seq,
        receivedAt,
        trades: JSON.parse(trades) as Array<Trade>,
      })),

  /** Lands on the row's key. Says whether the row is new. */
  upsertWall(wall: Wall): boolean {
    const known = sql
      .exec(
        "SELECT 1 FROM walls WHERE day = ? AND symbol = ? AND first_order_number = ?",
        wall.day,
        wall.symbol,
        wall.firstOrderNumber
      )
      .toArray()
    sql.exec(
      `INSERT OR REPLACE INTO walls (day, symbol, first_order_number, side, price, member_order_numbers, hits_seen,
         lots_matched, threshold, warming_up, prior, first_seen, last_seen, closed_at, closed_by, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      wall.day,
      wall.symbol,
      wall.firstOrderNumber,
      wall.side,
      wall.price,
      JSON.stringify(wall.memberOrderNumbers),
      wall.hitsSeen,
      wall.lotsMatched,
      wall.threshold,
      wall.warmingUp ? 1 : 0,
      wall.prior,
      wall.firstSeen,
      wall.lastSeen,
      wall.closedAt,
      wall.closedBy,
      wall.seq
    )
    return known.length === 0
  },

  /** The whole market's walls today, a few rows: what a restart puts back. */
  wallsToday: (day: string) =>
    sql
      .exec<WallRow>(
        `SELECT * FROM walls WHERE day = ? ${WALLS_NEWEST_FIRST}`,
        day
      )
      .toArray()
      .map(toWall),

  /** One symbol's day, newest first. */
  wallsOf: (day: string, symbol: Symbol) =>
    sql
      .exec<WallRow>(
        `SELECT * FROM walls WHERE day = ? AND symbol = ? ${WALLS_NEWEST_FIRST}`,
        day,
        symbol
      )
      .toArray()
      .map(toWall),

  /** `>=`: a `liveprice` hit changes a row without bumping `seq`. */
  /** The market's walls at `since` or later, newest first. */
  marketWallsSince: (day: string, since: number, limit: number) =>
    sql
      .exec<WallRow>(
        `SELECT * FROM walls WHERE day = ? AND seq >= ? ${WALLS_NEWEST_FIRST} LIMIT ?`,
        day,
        since,
        limit
      )
      .toArray()
      .map(toWall),

  wallsSince: (day: string, symbol: Symbol, since: number, limit: number) =>
    sql
      .exec<WallRow>(
        `SELECT * FROM walls WHERE day = ? AND symbol = ? AND seq >= ? ${WALLS_NEWEST_FIRST} LIMIT ?`,
        day,
        symbol,
        since,
        limit
      )
      .toArray()
      .map(toWall),
})
