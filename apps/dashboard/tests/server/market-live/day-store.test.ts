// The day store's replay path against SQLite's query planner: a recorded
// tape request runs up to four times a second per viewer over a million-row
// day, so no statement it runs may scan the trade chunks.
import { assert, describe, it } from "@effect/vitest"
import {
  MAX_CODE_BOOK_EVENTS,
  StockCode,
  TradeNumber,
  type BookEvent,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect, Exit } from "effect"
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
  it.effect("searches the trade chunks by number and never scans them", () =>
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
        { at: DateTime.makeUnsafe("2026-11-09T09:00:02.500+07:00") },
        200
      )
      assert.deepStrictEqual(
        trades.map((found) => found.tradeNumber),
        ["1", "2"]
      )
      const scans = statements
        .filter((statement) => /\btrade_chunks\b/.test(statement))
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

describe("the stored book events", () => {
  const moved: BookEvent = {
    kind: "moved",
    code: StockCode.make("BBNI"),
    at: DateTime.makeUnsafe("2026-11-17T07:02:33.250Z"),
    side: "bid",
    price: 3_620,
    lots: 28_711,
    orders: 3,
    wallLots: 30_000,
    to: 3_610,
  }
  const flush = {
    trades: [],
    candles: [],
    footprints: [],
    livePrices: [],
    chunks: [],
    ajaibBooks: [],
    facts: {},
    bookEvents: [moved],
  }

  it.effect("read back as the BookEvent written", () =>
    Effect.gen(function* () {
      const store = yield* makeDayStore(memorySql())
      yield* store.write(flush)
      assert.deepStrictEqual(
        yield* store.bookEventsOf(StockCode.make("BBNI")),
        [moved]
      )
      assert.deepStrictEqual(yield* store.newestBookEvents(10), [moved])
    })
  )

  it.effect("one code reads back as its newest MAX_CODE_BOOK_EVENTS", () =>
    Effect.gen(function* () {
      const store = yield* makeDayStore(memorySql())
      const at = DateTime.toEpochMillis(moved.at)
      const events = Array.from(
        { length: MAX_CODE_BOOK_EVENTS + 1 },
        (_, n): BookEvent => ({ ...moved, at: DateTime.makeUnsafe(at + n) })
      )
      yield* store.write({ ...flush, bookEvents: events })
      const read = yield* store.bookEventsOf(StockCode.make("BBNI"))
      assert.lengthOf(read, MAX_CODE_BOOK_EVENTS, "the read is capped")
      assert.deepStrictEqual(read[0], events[1], "the oldest drops")
      assert.deepStrictEqual(read.at(-1), events.at(-1))
    })
  )

  it.effect("a row whose figures don't decode is a defect", () =>
    Effect.gen(function* () {
      const sql = memorySql()
      const store = yield* makeDayStore(sql)
      yield* store.write(flush)
      sql.exec("UPDATE book_events SET detail = ?", '{"to":"far"}')
      const read = yield* Effect.exit(store.newestBookEvents(10))
      assert.isTrue(Exit.hasDies(read))
    })
  )
})
