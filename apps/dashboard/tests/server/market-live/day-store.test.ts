// The day store's replay path against SQLite's query planner: a recorded
// tape request runs up to four times a second per viewer over a million-row
// day, so no statement it runs may scan the trades table.
import { assert, describe, it } from "@effect/vitest"
import {
  MINUTE_MS,
  StockCode,
  TradeNumber,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import {
  makeDayStore,
  type Sql,
  type SqlValue,
} from "@/server/market-live/day-store"

import { memorySql } from "./sql"

// Node's SQLite behind the store's `Sql`, keeping every statement it ran.
const recordingSql = () => {
  const database = new DatabaseSync(":memory:")
  const statements: Array<string> = []
  const sql: Sql = {
    exec: (query, ...bindings) => {
      statements.push(query)
      return database
        .prepare(query)
        .all(...(bindings as Array<SQLInputValue>)) as Array<
        Record<string, SqlValue>
      >
    },
    transaction: (write) => {
      database.exec("BEGIN")
      write()
      database.exec("COMMIT")
    },
  }
  const plan = (query: string) =>
    (
      database.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{
        detail: string
      }>
    ).map((row) => row.detail)
  return { sql, statements, plan }
}

const trade = (number: number, at: string): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time: DateTime.makeUnsafe(`2026-11-09T${at}+07:00`),
  code: StockCode.make("BBCA"),
  price: 9_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Ajaib"],
})

const wib = (at: string) => DateTime.makeUnsafe(`2026-11-09T${at}+07:00`)

const numbers = (trades: ReadonlyArray<RunningTrade>) =>
  trades.map((found) => found.tradeNumber)

describe("the recorded tape's query plan", () => {
  it.effect("searches the trades table by number and never scans it", () =>
    Effect.gen(function* () {
      const { sql, statements, plan } = recordingSql()
      const store = yield* makeDayStore(sql, { today: true })
      yield* store.write({
        trades: [
          trade(1, "09:00:01"),
          trade(2, "09:00:02"),
          trade(3, "09:00:03"),
        ],
        candles: [],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
      })
      statements.length = 0
      const trades = yield* store.tradesAt(
        { at: DateTime.makeUnsafe("2026-11-09T09:00:02.500+07:00") },
        200
      )
      assert.deepStrictEqual(
        trades.map((found) => found.tradeNumber),
        ["1", "2"]
      )
      const scans = statements
        .filter((statement) => /\btrades\b/.test(statement))
        .flatMap((statement) =>
          plan(statement)
            .filter((detail) => detail.startsWith("SCAN"))
            .map((detail) => `${detail}: ${statement}`)
        )
      assert.deepStrictEqual(scans, [])
    })
  )
})

// Stockbit times a trade to the millisecond, Ajaib and the backfill to the
// second, so a trade's stored time can be earlier than the one before it.
describe("the recorded tape with mixed feed precision", () => {
  it.effect("finds a trade whose time is before its predecessor's", () =>
    Effect.gen(function* () {
      const store = yield* makeDayStore(recordingSql().sql, { today: true })
      yield* store.write({
        trades: [trade(1, "09:00:00.900"), trade(2, "09:00:00.000")],
        candles: [],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
      })
      assert.deepStrictEqual(
        numbers(yield* store.tradesAt({ at: wib("09:00:00.500") }, 200)),
        ["2"]
      )
      assert.deepStrictEqual(
        numbers(
          yield* store.tradesBetween(wib("08:59:59.000"), wib("09:00:00.500"))
        ),
        ["2"]
      )
    })
  )

  it.effect("keeps the newest `limit` trades after the time filter", () =>
    Effect.gen(function* () {
      const store = yield* makeDayStore(recordingSql().sql, { today: true })
      yield* store.write({
        trades: [
          trade(1, "09:00:00.000"),
          trade(2, "09:00:00.100"),
          trade(3, "09:00:00.900"),
          trade(4, "09:00:00.950"),
          trade(5, "09:00:00.200"),
        ],
        candles: [],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
      })
      assert.deepStrictEqual(
        numbers(yield* store.tradesAt({ at: wib("09:00:00.500") }, 2)),
        ["2", "5"]
      )
    })
  )
})

describe("the cost meter", () => {
  it.effect("adds the rows the database counted to its billed figures", () =>
    Effect.gen(function* () {
      // Counts a written row per INSERT and a read row per row returned.
      const inner = memorySql()
      const used = { rowsRead: 0, rowsWritten: 0, bytes: 0 }
      const store = yield* makeDayStore(
        {
          ...inner,
          exec: (query, ...bindings) => {
            const rows = inner.exec(query, ...bindings)
            if (query.startsWith("INSERT")) used.rowsWritten += 1
            else used.rowsRead += rows.length
            return rows
          },
          usage: () => ({ ...used }),
        },
        { today: true }
      )
      yield* store.write({
        trades: [trade(1, "09:00:00.000"), trade(2, "09:00:10.000")],
        candles: [],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
      })
      const written = used.rowsWritten
      const readBefore = used.rowsRead
      const reread = yield* store.storedMinuteTrades(
        StockCode.make("BBCA"),
        DateTime.toEpochMillis(wib("09:00:00"))
      )
      const meter = yield* store.takeMeter
      assert.deepStrictEqual(numbers(reread), ["1", "2"])
      assert.isAbove(written, 0)
      assert.strictEqual(meter.billedRowsWritten, written)
      assert.isAbove(used.rowsRead - readBefore, 0)
      assert.strictEqual(
        meter.billedMinuteRereadRows,
        used.rowsRead - readBefore
      )
    })
  )
})

// The candles table as stores before spec apinrdw/kumora#427 made it, and
// its trades table, which that spec left as it was.
const oldStore = (sql: Sql) => {
  sql.exec(`CREATE TABLE trades (
      number INTEGER PRIMARY KEY,
      time INTEGER NOT NULL,
      code TEXT NOT NULL,
      price REAL NOT NULL,
      lots REAL NOT NULL,
      side TEXT NOT NULL,
      board TEXT NOT NULL,
      feeds TEXT NOT NULL
    )`)
  sql.exec(`CREATE TABLE candles (
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
        ) WITHOUT ROWID`)
}

// One candle in the old table, `value` and `frequency` its own.
const oldCandle = (
  sql: Sql,
  code: string,
  minute: number,
  value: number,
  frequency: number
) =>
  sql.exec(
    "INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    code,
    minute,
    1,
    9_000,
    2,
    9_025,
    minute + 2_000,
    9_025,
    9_000,
    frequency,
    value,
    frequency
  )

// An old store holding BBCA's trades of 09:00 and 09:01, on every side and
// one off the regular board, TLKM's of 09:00, and the candles they fold to;
// sealed when `sealed`.
const oldDay = (sealed: boolean) => {
  const sql = memorySql()
  oldStore(sql)
  const tlkm = StockCode.make("TLKM")
  for (const stored of [
    trade(1, "09:00:01"),
    { ...trade(2, "09:00:20"), price: 9_025, side: "sell" as const },
    { ...trade(3, "09:00:40"), price: 9_025, side: "none" as const },
    { ...trade(4, "09:00:50"), lots: 5, board: "NG" as const },
    {
      ...trade(5, "09:00:55"),
      code: tlkm,
      price: 3_000,
      side: "sell" as const,
    },
    { ...trade(6, "09:01:10"), lots: 2 },
  ])
    sql.exec(
      "INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Number(stored.tradeNumber),
      DateTime.toEpochMillis(stored.time),
      stored.code,
      stored.price,
      stored.lots,
      stored.side,
      stored.board,
      stored.feeds.join(",")
    )
  const first = DateTime.toEpochMillis(wib("09:00:00"))
  oldCandle(sql, "BBCA", first, 2_705_000, 3)
  oldCandle(sql, "BBCA", first + MINUTE_MS, 1_800_000, 1)
  oldCandle(sql, "TLKM", first, 300_000, 1)
  if (sealed) {
    sql.exec("CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    sql.exec("INSERT INTO facts VALUES ('sealed', '2026-11-09T09:00:00Z')")
  }
  return { sql, first }
}

// Each of `code`'s candles as a store opened on `sql` reads it, as today's
// day when `today`: its minute, buy value and sell value.
const sidesOf = (sql: Sql, code: string, today: boolean) =>
  Effect.gen(function* () {
    const store = yield* makeDayStore(sql, { today })
    const candles = yield* store.storedCandlesOf(StockCode.make(code))
    return candles.map(({ minute, figures }) => [
      minute,
      figures.buyValue,
      figures.sellValue,
    ])
  })

describe("a day store from before candles carried buy and sell value", () => {
  it.effect(
    "rebuilds the live day's candle sides from its regular-board trades",
    () =>
      Effect.gen(function* () {
        const { sql, first } = oldDay(false)
        assert.deepStrictEqual(yield* sidesOf(sql, "BBCA", true), [
          [first, 900_000, 902_500],
          [first + MINUTE_MS, 1_800_000, 0],
        ])
        assert.deepStrictEqual(yield* sidesOf(sql, "TLKM", true), [
          [first, 0, 300_000],
        ])
      })
  )

  it.effect(
    "rebuilds today's candle sides after its seal, which still serves its bubbles",
    () =>
      Effect.gen(function* () {
        const { sql, first } = oldDay(true)
        assert.deepStrictEqual(yield* sidesOf(sql, "BBCA", true), [
          [first, 900_000, 902_500],
          [first + MINUTE_MS, 1_800_000, 0],
        ])
      })
  )

  it.effect("leaves a sealed day's candle sides at 0", () =>
    Effect.gen(function* () {
      const { sql, first } = oldDay(true)
      assert.deepStrictEqual(yield* sidesOf(sql, "BBCA", false), [
        [first, 0, 0],
        [first + MINUTE_MS, 0, 0],
      ])
    })
  )

  it.effect("gains both columns at 0, keeps its candles, and opens again", () =>
    Effect.gen(function* () {
      const sql = memorySql()
      oldStore(sql)
      const minute = DateTime.toEpochMillis(wib("09:00:00"))
      oldCandle(sql, "BBCA", minute, 2_707_500, 2)
      const old = yield* makeDayStore(sql, { today: true })
      const [kept] = yield* old.storedCandlesOf(StockCode.make("BBCA"))
      assert.deepStrictEqual(
        {
          value: kept?.figures.value,
          buyValue: kept?.figures.buyValue,
          sellValue: kept?.figures.sellValue,
        },
        { value: 2_707_500, buyValue: 0, sellValue: 0 }
      )
      const reopened = yield* makeDayStore(sql, { today: true })
      const later = minute + MINUTE_MS
      yield* reopened.write({
        trades: [],
        candles: [
          {
            code: StockCode.make("BBCA"),
            minute: later,
            figures: {
              ...kept!.figures,
              value: 900_000,
              buyValue: 600_000,
              sellValue: 300_000,
            },
          },
        ],
        footprints: [],
        livePrices: [],
        chunks: [],
        ajaibBooks: [],
        facts: {},
      })
      const candles = yield* reopened.storedCandlesOf(
        StockCode.make("BBCA"),
        minute
      )
      assert.deepStrictEqual(
        candles.map(({ figures }) => [figures.buyValue, figures.sellValue]),
        [[600_000, 300_000]]
      )
    })
  )
})
