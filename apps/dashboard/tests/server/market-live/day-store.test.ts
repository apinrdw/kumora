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

import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
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
      const store = yield* makeDayStore(sql)
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
        DateTime.makeUnsafe("2026-11-09T09:00:02.500+07:00"),
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
      const store = yield* makeDayStore(recordingSql().sql)
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
        numbers(yield* store.tradesAt(wib("09:00:00.500"), 200)),
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
      const store = yield* makeDayStore(recordingSql().sql)
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
        numbers(yield* store.tradesAt(wib("09:00:00.500"), 2)),
        ["2", "5"]
      )
    })
  )
})

describe("the one-off build's span", () => {
  it.effect(
    "reads a full day of book chunks without holding every chunk's key",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        const store = yield* makeDayStore(sql)
        const open = DateTime.toEpochMillis(wib("08:58:00"))
        sql.transaction(() => {
          for (let code = 0; code < FULL_DAY_CODES; code++)
            for (let minute = 0; minute < FULL_DAY_MINUTES; minute++)
              sql.exec(
                "INSERT INTO book_chunks VALUES (?, ?, ?)",
                `C${code}`,
                open + minute * MINUTE_MS,
                new Uint8Array(1)
              )
        })
        const span = yield* store.orderFlowMinutes
        assert.strictEqual(span?.first, open)
        assert.strictEqual(
          span?.last,
          open + (FULL_DAY_MINUTES - 1) * MINUTE_MS
        )
        assert.strictEqual(span?.chunkCodes.length, FULL_DAY_CODES)
      }),
    60_000
  )
})

describe("the cost meter", () => {
  it.effect("adds the rows the database counted to its billed figures", () =>
    Effect.gen(function* () {
      // Counts a written row per INSERT and a read row per row returned.
      const inner = memorySql()
      const used = { rowsRead: 0, rowsWritten: 0, bytes: 0 }
      const store = yield* makeDayStore({
        ...inner,
        exec: (query, ...bindings) => {
          const rows = inner.exec(query, ...bindings)
          if (query.startsWith("INSERT")) used.rowsWritten += 1
          else used.rowsRead += rows.length
          return rows
        },
        usage: () => ({ ...used }),
      })
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
