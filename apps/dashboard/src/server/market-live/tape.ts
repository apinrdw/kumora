// A trading day's tape: every read and write of the day's trades (spec
// apinrdw/kumora#555, tickets #567 and #571). A new day keeps them as
// 1,000-number chunks (tape-chunks.ts); a day recorded before keeps its row
// per trade in `trades`, here, and the `kumora/tape-owns-trades` lint fails
// on SQL against that table anywhere else.
import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type TapeCursor,
  MINUTE_MS,
  SHARES_PER_LOT,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { Sql, SqlValue } from "./day-store.ts"
import {
  TIME_SKEW_MS,
  minutesSpanning,
  type Tape,
  type TapeFields,
} from "./tape-backing.ts"
import { makeChunkTape } from "./tape-chunks.ts"

// A day recorded before trade chunks holds a trade as one row keyed by its
// number as the INTEGER PRIMARY KEY, with no secondary index (spec
// apinrdw/kumora#138, "Storage and cost"): number, time, code, price, lots,
// side, board and feeds. No day makes the table any more.

// Each stored candle's buy and sell value from the stored trades, by
// candles.ts `printOf`'s value by side and `counts`'s regular-board filter: a
// stored candle folds the settled regular-board trades of its code and
// minute, and a flush writes those trades with it.
const REBUILD_CANDLE_SIDES = `UPDATE candles
  SET buy_value = sides.buy, sell_value = sides.sell
  FROM (
    SELECT code, time - time % ${MINUTE_MS} AS minute,
      SUM(CASE side WHEN 'buy' THEN price * lots * ${SHARES_PER_LOT} ELSE 0 END) AS buy,
      SUM(CASE side WHEN 'sell' THEN price * lots * ${SHARES_PER_LOT} ELSE 0 END) AS sell
    FROM trades WHERE board = 'RG' GROUP BY code, minute
  ) AS sides
  WHERE candles.code = sides.code AND candles.minute = sides.minute`

// A trade's or walk row's fields, read back without a decode: the rows are
// the day's own writes.
export const fieldsOf = (row: Record<string, SqlValue>) =>
  Effect.sync((): TapeFields => ({
    number: Number(row.number),
    code: StockCode.make(String(row.code)),
    price: Number(row.price),
    lots: Number(row.lots),
    board: String(row.board) as RunningTrade["board"],
  }))

// Rows are the tape's own writes, so they are read back without a decode.
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

// The plain methods run inside a transaction (tape-backing.ts, Tape).
const makeRowTape = (sql: Sql): Tape => {
  // `trades` inside a transaction. A number is written once: a copy can't
  // replace it.
  const write = (trades: ReadonlyArray<RunningTrade>) => {
    for (const trade of trades)
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
  }

  // The lowest or highest number held. One aggregate per statement: SQLite
  // reads a lone min() or max() off the primary key's end, but scans the
  // whole table for a statement that asks for both.
  const boundNumber = (bound: "min" | "max") => {
    const [row] = sql.exec(`SELECT ${bound}(number) AS number FROM trades`)
    return row === undefined || row.number === null
      ? undefined
      : Number(row.number)
  }
  const highestNumber = () => boundNumber("max")

  // The numbers held from `low` to `high`, ascending.
  const numbersBetween = (low: number, high: number) =>
    sql
      .exec(
        "SELECT number FROM trades WHERE number BETWEEN ? AND ? ORDER BY number",
        low,
        high
      )
      .map((row) => Number(row.number))

  const rebuildCandleSides = () => {
    sql.exec(REBUILD_CANDLE_SIDES)
  }

  const has = (tradeNumber: TradeNumber) =>
    Effect.sync(
      () =>
        sql.exec("SELECT 1 FROM trades WHERE number = ?", Number(tradeNumber))
          .length > 0
    )

  // How many trades the day stored so far.
  const count = Effect.sync(() =>
    Number(sql.exec("SELECT count(*) AS count FROM trades")[0]?.count)
  )

  // The newest `limit` trades, ascending.
  const newest = Effect.fnUntraced(function* (limit: number) {
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
    let low = boundNumber("min")
    let high = boundNumber("max")
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

  // The newest `limit` trades at or before `at`, below `before` when it is
  // given, ascending: SQLite walks the primary key down from the lower of
  // the search's number and `before`, and skips the rows the skew lets past
  // it.
  const tradesAt = Effect.fnUntraced(function* (
    { at, before }: TapeCursor,
    limit: number
  ) {
    const cutoff = DateTime.toEpochMillis(at)
    const found = yield* highestWithin(cutoff)
    if (found === undefined) return []
    const highest =
      before === undefined ? found : Math.min(found, Number(before) - 1)
    const trades = yield* Effect.forEach(
      sql.exec(
        "SELECT * FROM trades WHERE number <= ? AND time <= ? ORDER BY number DESC LIMIT ?",
        highest,
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

  // The first and last minute that can hold a stored trade; none when the
  // day stored none. They come off the primary key's ends, widened by
  // TIME_SKEW_MS: a later-numbered trade can be stored up to that much
  // before the first, and an earlier one that much after the last.
  const minuteSpan = Effect.sync(() => {
    const minutes: Array<number> = []
    for (const [bound, skew] of [
      ["min", -TIME_SKEW_MS],
      ["max", TIME_SKEW_MS],
    ] as const) {
      const number = boundNumber(bound)
      if (number === undefined) continue
      const [row] = sql.exec("SELECT time FROM trades WHERE number = ?", number)
      minutes.push(
        Math.floor((Number(row?.time) + skew) / MINUTE_MS) * MINUTE_MS
      )
    }
    const [first, last] = minutes
    return first === undefined || last === undefined
      ? undefined
      : { first, last }
  })

  // The minutes the stored trades numbered `first` to `last` fall in,
  // ascending; none when it holds none of them.
  const minutesOf = Effect.fnUntraced(function* (
    first: TradeNumber,
    last: TradeNumber
  ) {
    const [row] = sql.exec(
      "SELECT min(time) AS first, max(time) AS last FROM trades WHERE number BETWEEN ? AND ?",
      Number(first),
      Number(last)
    )
    if (row === undefined || row.first === null) return []
    return yield* minutesSpanning(Number(row.first), Number(row.last))
  })

  // The numbers from `low` to `high` the tape lacks, marked 1 in `marks`
  // from `low`.
  // Decision: a span the tape holds whole is known from its count; any other
  // reads the runs between the tape's numbers, so no row per taped trade sits
  // in memory. A 1.5M-trade day's status scan took 152 ms in Node's SQLite,
  // against 118 ms for codes alone and 850 ms reading the runs everywhere.
  const markLacking = (low: number, high: number, marks: Uint8Array) =>
    Effect.sync(() => {
      const [taped] = sql.exec(
        "SELECT count(*) AS count FROM trades WHERE number BETWEEN ? AND ?",
        low,
        high
      )
      if (Number(taped?.count) === high - low + 1) return
      for (const row of sql.exec(
        `SELECT prev + 1 AS first, number - 1 AS last FROM (
          SELECT number, lag(number, 1, ?) OVER (ORDER BY number) AS prev
          FROM trades WHERE number BETWEEN ? AND ?
        ) WHERE number > prev + 1`,
        low - 1,
        low,
        high
      ))
        marks.fill(1, Number(row.first) - low, Number(row.last) - low + 1)
      const [tapeHigh] = sql.exec(
        "SELECT max(number) AS number FROM trades WHERE number BETWEEN ? AND ?",
        low,
        high
      )
      marks.fill(1, Number(tapeHigh?.number ?? low - 1) - low + 1)
    })

  // The fields of the trades held from `low` to `high`, ascending.
  const fieldsBetween = (low: number, high: number) =>
    Effect.suspend(() =>
      Effect.forEach(
        sql.exec(
          "SELECT number, code, price, lots, board FROM trades WHERE number BETWEEN ? AND ? ORDER BY number",
          low,
          high
        ),
        fieldsOf
      )
    )

  return {
    shape: "rows",
    write,
    highestNumber,
    numbersBetween,
    rebuildCandleSides,
    has,
    count,
    newest,
    tradesAt,
    tradesBetween,
    minuteSpan,
    minutesOf,
    markLacking,
    fieldsBetween,
  }
}

// Decision: a day's tape shape is which table it holds: `trades`, made only
// by days recorded before trade chunks, keeps its rows until the day turns
// cold, and every other day is chunked. Old days are never rewritten. See
// spec apinrdw/kumora#555, "Trade chunks".
export const makeTape = (sql: Sql): Tape =>
  sql.exec("PRAGMA table_info(trades)").length > 0
    ? makeRowTape(sql)
    : makeChunkTape(sql)
