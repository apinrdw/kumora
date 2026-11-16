// BrokerTotalsDb, the broker totals D1 (BROKER_TOTALS_DB in alchemy.run.ts;
// schema in broker-totals-migrations/): each complete day's per-broker
// totals and daily candles, which its trading-day object writes (spec
// apinrdw/kumora#437, "Dashboard: broker totals DB") and the stock page reads
// by range. Code reaches it only through `batch`, which runs its statements
// in order as one transaction, as D1's `batch` does. Tests provide an
// in-memory SQLite one.
import {
  BrokerCode,
  WibDate,
  type InvestorType,
  type StockCode,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Context, DateTime, Effect, Layer, Schema } from "effect"

import { d1Batch, type D1Batch, type Statement } from "../d1.ts"
import { monthRows } from "../holdings/month-replace.ts"

export class BrokerTotalsDbError extends Schema.TaggedError<BrokerTotalsDbError>()(
  "BrokerTotalsDbError",
  { cause: Schema.Defect() }
) {}

export class BrokerTotalsDb extends Context.Service<
  BrokerTotalsDb,
  {
    // Each statement's rows, in order, and the rows the batch wrote. A
    // failing statement rolls back the whole batch.
    readonly batch: (
      statements: ReadonlyArray<Statement>
    ) => Effect.Effect<D1Batch, BrokerTotalsDbError>
  }
>()("dashboard/broker-totals/BrokerTotalsDb") {}

export const brokerTotalsDbD1 = Layer.effect(
  BrokerTotalsDb,
  Effect.gen(function* () {
    const db = (yield* WorkerEnv).BROKER_TOTALS_DB
    return BrokerTotalsDb.of({
      batch: (statements) =>
        d1Batch(db, statements, (cause) => new BrokerTotalsDbError({ cause })),
    })
  })
)

// One broker's buys and sells of one stock on a day, by investor type.
export interface BrokerTotal {
  readonly code: StockCode
  readonly broker: BrokerCode
  readonly investorType: InvestorType
  readonly buyLots: number
  readonly buyValue: number
  readonly sellLots: number
  readonly sellValue: number
}

// One stock's regular-board day.
export interface DayCandle {
  readonly code: StockCode
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly value: number
}

// What a build makes of one day.
export interface DayBuild {
  readonly totals: ReadonlyArray<BrokerTotal>
  readonly candles: ReadonlyArray<DayCandle>
}

const TOTALS_COLUMNS = [
  "code",
  "broker",
  "investor_type",
  "buy_lots",
  "buy_value",
  "sell_lots",
  "sell_value",
]
const CANDLES_COLUMNS = [
  "code",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "value",
]

// Decision: a build's inserts go in batches of at most this many
// statements, each statement one INSERT … SELECT over json_each of at most
// 1,000 rows and 90,000 bytes (monthRows, as a month replace's), under D1's
// 100 KB a statement. A ~60,000-row day is 7 batches. See
// apinrdw/kumora#419.
const STATEMENTS_PER_BATCH = 10

// The day's rows of one table as INSERT statements.
const insertsOf = Effect.fnUntraced(function* <Row>(
  day: WibDate,
  table: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<Row>,
  values: (row: Row) => Statement["params"]
) {
  const chunks = yield* monthRows(table, columns)
  for (const row of rows) yield* chunks.add(values(row))
  const sql =
    `INSERT INTO ${table} (day, ${columns.join(", ")}) ` +
    `SELECT ?, ${columns.map((_, index) => `value->>${index}`).join(", ")} ` +
    "FROM json_each(?)"
  return (yield* chunks.gathered).chunks.map((chunk): Statement => ({
    sql,
    params: [day, chunk],
  }))
})

// Decision: a day is written in this order: its built-days row deleted, its
// totals and candles deleted and inserted in batches, its built-days row
// inserted last. A half-written or rebuilding day reads as a gap, and a
// repeat converges: every write starts by deleting the day. See
// apinrdw/kumora#419.
//
// The statements and rows it wrote, for the build's log line.
export const writeBuiltDay = Effect.fnUntraced(function* (
  day: WibDate,
  build: DayBuild,
  version: number,
  builtAt: DateTime.Utc
) {
  const db = yield* BrokerTotalsDb
  const inserts = [
    ...(yield* insertsOf(day, "totals", TOTALS_COLUMNS, build.totals, (row) => [
      row.code,
      row.broker,
      row.investorType,
      row.buyLots,
      row.buyValue,
      row.sellLots,
      row.sellValue,
    ])),
    ...(yield* insertsOf(
      day,
      "candles",
      CANDLES_COLUMNS,
      build.candles,
      (row) => [
        row.code,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume,
        row.value,
      ]
    )),
  ]
  const batches: Array<ReadonlyArray<Statement>> = [
    [
      { sql: "DELETE FROM built_days WHERE day = ?", params: [day] },
      { sql: "DELETE FROM totals WHERE day = ?", params: [day] },
      { sql: "DELETE FROM candles WHERE day = ?", params: [day] },
    ],
  ]
  for (let at = 0; at < inserts.length; at += STATEMENTS_PER_BATCH)
    batches.push(inserts.slice(at, at + STATEMENTS_PER_BATCH))
  batches.push([
    {
      sql: "INSERT INTO built_days (day, build_version, built_at) VALUES (?, ?, ?)",
      params: [day, version, DateTime.formatIso(builtAt)],
    },
  ])
  let rowsWritten = 0
  for (const batch of batches)
    rowsWritten += (yield* db.batch(batch)).rowsWritten
  return {
    statements: batches.reduce((sum, batch) => sum + batch.length, 0),
    rowsWritten,
  }
})

const BuiltDayRow = Schema.Struct({
  day: WibDate,
  buildVersion: Schema.Number,
  builtAt: Schema.String,
})

const CandleRow = Schema.Struct({
  day: WibDate,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
  volume: Schema.Number,
  value: Schema.Number,
})

const TotalRow = Schema.Struct({
  day: WibDate,
  broker: BrokerCode,
  investorType: Schema.Literals(["D", "F"]),
  buyLots: Schema.Number,
  buyValue: Schema.Number,
  sellLots: Schema.Number,
  sellValue: Schema.Number,
})

const decodeRange = Schema.decodeUnknownEffect(
  Schema.Struct({
    builtDays: Schema.Array(BuiltDayRow),
    candles: Schema.Array(CandleRow),
    totals: Schema.Array(TotalRow),
  })
)

const decodeSpan = Schema.decodeUnknownEffect(
  Schema.Struct({
    earliest: Schema.NullOr(WibDate),
    newest: Schema.NullOr(WibDate),
  })
)

// The first and the newest built day at or before `upTo`; both null before
// any build.
export const readBuiltSpan = Effect.fnUntraced(function* (upTo: WibDate) {
  const {
    rows: [[span]],
  } = yield* (yield* BrokerTotalsDb).batch([
    {
      sql: "SELECT MIN(day) AS earliest, MAX(day) AS newest FROM built_days WHERE day <= ?",
      params: [upTo],
    },
  ])
  return yield* decodeSpan(span).pipe(Effect.orDie)
})

// A day of the range is read only when it has a built-days row.
const BUILT_IN_RANGE =
  "day BETWEEN ? AND ? AND day IN (SELECT day FROM built_days WHERE day BETWEEN ? AND ?)"

// Decision: the range read is one batch of three key-range reads, so a day
// rebuilt meanwhile reads whole or as a gap, never half. See
// apinrdw/kumora#419.
//
// The built days of from..to, each in day order, with `code`'s candles and
// totals on them.
export const readBrokerTotals = Effect.fnUntraced(function* (
  code: StockCode,
  from: WibDate,
  to: WibDate
) {
  const range = [from, to, from, to]
  const {
    rows: [builtDays, candles, totals],
  } = yield* (yield* BrokerTotalsDb).batch([
    {
      sql: "SELECT day, build_version AS buildVersion, built_at AS builtAt FROM built_days WHERE day BETWEEN ? AND ? ORDER BY day",
      params: [from, to],
    },
    {
      sql: `SELECT day, open, high, low, close, volume, value FROM candles WHERE code = ? AND ${BUILT_IN_RANGE} ORDER BY day`,
      params: [code, ...range],
    },
    {
      sql: `SELECT day, broker, investor_type AS investorType, buy_lots AS buyLots, buy_value AS buyValue, sell_lots AS sellLots, sell_value AS sellValue FROM totals WHERE code = ? AND ${BUILT_IN_RANGE} ORDER BY day, broker, investor_type`,
      params: [code, ...range],
    },
  ])
  return yield* decodeRange({ builtDays, candles, totals }).pipe(Effect.orDie)
})
