// A day's tape on both of its shapes (spec apinrdw/kumora#555, ticket #571):
// a new day's 1,000-number trade chunks, and the row per trade a day recorded
// before keeps. Every read answers the same on both.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeDayStore, type Sql } from "@/server/market-live/day-store"
import { makeTape } from "@/server/market-live/tape"

import { memorySql, rowShapedSql } from "./sql"

const wib = (at: string) => DateTime.makeUnsafe(`2026-11-09T${at}+07:00`)

// A trade at a WIB time of day, or `at` ms after 09:00.
const trade = (
  number: number,
  at: string | number,
  change: Partial<RunningTrade> = {}
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time:
    typeof at === "string"
      ? wib(at)
      : DateTime.makeUnsafe(DateTime.toEpochMillis(wib("09:00:00")) + at),
  code: StockCode.make("BBCA"),
  price: 9_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Stockbit"],
  ...change,
})

const flushOf = (trades: ReadonlyArray<RunningTrade>) => ({
  trades,
  candles: [],
  footprints: [],
  livePrices: [],
  chunks: [],
  ajaibBooks: [],
  facts: {},
})

const numbers = (trades: ReadonlyArray<RunningTrade>) =>
  trades.map((found) => Number(found.tradeNumber))

// Trades across three chunks, a hole at 1,000 and 1,500..2,499, every field
// varied: numbered n at 09:00 plus n × 100 ms.
const TAPE: ReadonlyArray<RunningTrade> = [
  trade(1, "09:00:00.100", { feeds: ["Ajaib", "Stockbit"] }),
  trade(2, "09:00:00.200", {
    code: StockCode.make("TLKM"),
    price: 3_000,
    side: "sell",
  }),
  trade(3, "09:00:00.300", { side: "none", board: "NG", lots: 0.5 }),
  ...Array.from({ length: 995 }, (_, at) =>
    trade(at + 4, (at + 4) * 100, {
      code: StockCode.make(at % 2 === 0 ? "BBCA" : "GOTO"),
      lots: at + 1,
    })
  ),
  trade(999, "09:01:39.900", { board: "TN", feeds: ["walk"] }),
  ...Array.from({ length: 499 }, (_, at) =>
    trade(at + 1_001, "09:01:40.100", { feeds: ["backfill"] })
  ),
  trade(2_500, "09:04:10.000", { code: StockCode.make("ASII") }),
]

const shapes: ReadonlyArray<readonly [string, () => Sql]> = [
  ["a chunked day", memorySql],
  ["a row-per-trade day", rowShapedSql],
]

for (const [shape, makeSql] of shapes)
  describe(`the tape of ${shape}`, () => {
    const stored = Effect.gen(function* () {
      const sql = makeSql()
      const store = yield* makeDayStore(sql, { today: true })
      yield* store.write(flushOf(TAPE.slice(0, 600)))
      yield* store.write(flushOf(TAPE.slice(600)))
      return { sql, store }
    })

    it.effect("reads back every field of every trade it holds", () =>
      Effect.gen(function* () {
        const { store } = yield* stored
        assert.deepStrictEqual(
          yield* store.tradesBetween(wib("08:00:00"), wib("10:00:00")),
          TAPE
        )
        assert.strictEqual(yield* store.storedTrades, TAPE.length)
        assert.strictEqual(String(yield* store.highestTrade), "2500")
      })
    )

    it.effect("keeps a number's first copy", () =>
      Effect.gen(function* () {
        const { store } = yield* stored
        yield* store.write(
          flushOf([
            trade(2, "09:00:00.200", { price: 1 }),
            trade(1_000, "09:01:40.000"),
          ])
        )
        const [two] = yield* store.tradesBetween(
          wib("09:00:00.150"),
          wib("09:00:00.250")
        )
        assert.strictEqual(two?.price, 3_000)
        assert.isTrue(yield* store.hasTrade(TradeNumber.make("1000")))
        assert.isFalse(yield* store.hasTrade(TradeNumber.make("1500")))
        assert.isFalse(yield* store.hasTrade(TradeNumber.make("2501")))
      })
    )

    it.effect("answers a tape page at an instant and below a number", () =>
      Effect.gen(function* () {
        const { store } = yield* stored
        assert.deepStrictEqual(
          numbers(yield* store.tradesAt({ at: wib("09:01:40.100") }, 3)),
          [1_497, 1_498, 1_499]
        )
        assert.deepStrictEqual(
          numbers(
            yield* store.tradesAt(
              { at: wib("09:01:40.100"), before: TradeNumber.make("1002") },
              3
            )
          ),
          [998, 999, 1_001]
        )
        assert.deepStrictEqual(
          numbers(yield* store.tradesAt({ at: wib("09:00:00.250") }, 200)),
          [1, 2]
        )
        assert.deepStrictEqual(
          yield* store.tradesAt({ at: wib("08:59:00") }, 200),
          []
        )
        assert.deepStrictEqual(
          numbers(yield* store.newestTrades(2)),
          [1_499, 2_500]
        )
      })
    )

    it.effect("finds a trade timed before its predecessor", () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(makeSql(), { today: true })
        yield* store.write(
          flushOf([trade(1, "09:00:00.900"), trade(2, "09:00:00.000")])
        )
        assert.deepStrictEqual(
          numbers(yield* store.tradesAt({ at: wib("09:00:00.500") }, 200)),
          [2]
        )
        assert.deepStrictEqual(
          numbers(
            yield* store.tradesBetween(wib("08:59:59"), wib("09:00:00.500"))
          ),
          [2]
        )
      })
    )

    it.effect("answers a minute's trades and the minutes trades fall in", () =>
      Effect.gen(function* () {
        const { store } = yield* stored
        const minute = DateTime.toEpochMillis(wib("09:04:00"))
        assert.deepStrictEqual(
          numbers(yield* store.minuteTrades(minute)),
          [2_500]
        )
        assert.deepStrictEqual(
          yield* store.minutesOfTrades(
            TradeNumber.make("990"),
            TradeNumber.make("2500")
          ),
          [1, 2, 3, 4].map((at) => minute - (4 - at) * MINUTE_MS)
        )
        const span = yield* store.orderFlowMinutes
        assert.deepStrictEqual(span, {
          first: DateTime.toEpochMillis(wib("08:59:00")),
          last: minute,
        })
      })
    )

    it.effect(
      "hands the broker codes store its numbers, holes and fields",
      () =>
        Effect.gen(function* () {
          const { sql } = yield* stored
          const tape = makeTape(sql)
          assert.deepStrictEqual(
            tape.numbersBetween(997, 1_002),
            [997, 998, 999, 1_001, 1_002]
          )
          assert.strictEqual(tape.highestNumber(), 2_500)
          const marks = new Uint8Array(3_000)
          yield* tape.markLacking(1, 3_000, marks)
          const lacking = [...marks.keys()]
            .filter((at) => marks[at] === 1)
            .map((at) => at + 1)
          assert.deepStrictEqual(lacking, [
            1_000,
            ...Array.from({ length: 1_000 }, (_, at) => 1_500 + at).filter(
              (number) => number !== 2_500
            ),
            ...Array.from({ length: 500 }, (_, at) => 2_501 + at),
          ])
          assert.deepStrictEqual(yield* tape.fieldsBetween(2, 3), [
            {
              number: 2,
              code: StockCode.make("TLKM"),
              price: 3_000,
              lots: 1,
              board: "RG",
            },
            {
              number: 3,
              code: StockCode.make("BBCA"),
              price: 9_000,
              lots: 0.5,
              board: "NG",
            },
          ])
        })
    )

    it.effect("reads the same tape after a restart", () =>
      Effect.gen(function* () {
        const { sql, store } = yield* stored
        const before = yield* store.tradesBetween(
          wib("08:00:00"),
          wib("10:00:00")
        )
        const restarted = yield* makeDayStore(sql, { today: true })
        yield* restarted.write(
          flushOf([
            trade(2_501, "09:04:10.100", { code: StockCode.make("UNVR") }),
          ])
        )
        assert.deepStrictEqual(
          yield* restarted.tradesBetween(wib("08:00:00"), wib("10:00:00")),
          [
            ...before,
            trade(2_501, "09:04:10.100", { code: StockCode.make("UNVR") }),
          ]
        )
      })
    )
  })

// Rows written by table, as a write statement names it.
const writesOf = (statements: ReadonlyArray<string>) =>
  statements
    .filter((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))
    .map((query) => /(?:INTO|UPDATE|FROM)\s+(\w+)/i.exec(query)?.[1])

const watched = (sql: Sql) => {
  const statements: Array<string> = []
  return {
    statements,
    sql: {
      ...sql,
      exec: (
        query: string,
        ...bindings: ReadonlyArray<Parameters<Sql["exec"]>[1]>
      ) => {
        statements.push(query)
        return sql.exec(query, ...bindings)
      },
    } satisfies Sql,
  }
}

describe("a chunked day's writes", () => {
  it.effect(
    "a flush rewrites only the chunks it adds trades to, and the code list when a code is new",
    () =>
      Effect.gen(function* () {
        const { sql, statements } = watched(memorySql())
        const store = yield* makeDayStore(sql, { today: true })
        yield* store.write(flushOf(TAPE))
        statements.length = 0
        yield* store.write(
          flushOf([trade(2_501, "09:04:10.100"), trade(2_502, "09:04:10.200")])
        )
        assert.deepStrictEqual(writesOf(statements), ["trade_chunks"])
        statements.length = 0
        yield* store.write(
          flushOf([
            trade(3_001, "09:04:11.000", { code: StockCode.make("UNVR") }),
          ])
        )
        assert.deepStrictEqual(writesOf(statements), ["trade_chunks", "facts"])
      })
  )

  it.effect("a late trade rewrites its own chunk alone", () =>
    Effect.gen(function* () {
      const { sql, statements } = watched(memorySql())
      const store = yield* makeDayStore(sql, { today: true })
      yield* store.write(flushOf(TAPE))
      statements.length = 0
      yield* store.write(flushOf([trade(1_000, "09:01:40.000")]))
      assert.deepStrictEqual(writesOf(statements), ["trade_chunks"])
      statements.length = 0
      yield* store.write(flushOf([trade(1_000, "09:01:40.000")]))
      assert.deepStrictEqual(writesOf(statements), [])
    })
  )

  it.effect(
    "a flush that fails keeps the code list and the chunks as they were, before and after a restart",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        const store = yield* makeDayStore(sql, { today: true })
        yield* store.write(flushOf(TAPE))
        const failed = yield* Effect.exit(
          store.write({
            ...flushOf([
              trade(2_501, "09:04:10.100", { code: StockCode.make("UNVR") }),
            ]),
            // A statement that fails rolls the flush back.
            alsoWrites: () => {
              sql.exec("INSERT INTO no_such_table VALUES (1)")
            },
          })
        )
        assert.isTrue(failed._tag === "Failure")
        const later = trade(2_502, "09:04:10.200", {
          code: StockCode.make("ADRO"),
        })
        yield* store.write(flushOf([later]))
        const restarted = yield* makeDayStore(sql, { today: true })
        for (const read of [store, restarted]) {
          assert.isFalse(yield* read.hasTrade(TradeNumber.make("2501")))
          assert.deepStrictEqual(
            (yield* read.newestTrades(2)).map((found) => found.code),
            ["ASII", "ADRO"]
          )
        }
      })
  )

  it.effect(
    "a day recorded before keeps its trade rows and writes no chunk",
    () =>
      Effect.gen(function* () {
        const { sql, statements } = watched(rowShapedSql())
        const store = yield* makeDayStore(sql, { today: true })
        yield* store.write(flushOf(TAPE.slice(0, 3)))
        assert.notInclude(writesOf(statements), "trade_chunks")
        assert.deepStrictEqual(
          sql.exec(
            "SELECT name FROM sqlite_schema WHERE name = 'trade_chunks'"
          ),
          []
        )
      })
  )
})
