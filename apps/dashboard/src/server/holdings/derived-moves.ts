// Holder moves' lines of one kind, derived period by period from its parsed
// periods by the parse run that parses them: Daily's from the above-5% days
// (above-5-moves.ts), Monthly's from the above-1% months (above-1-moves.ts).
// The run derives each period whose basis changed, so the Holder moves page
// reads one period's lines (holder-moves.ts). A period's lines are each
// moving stock's movers in it by the kind's panel, from the stock's periods
// the panel reads up to it (holders-window.ts). Spec apinrdw/kumora#673,
// "Holder moves".
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { sha256Hex } from "../archive/hash.ts"
import { decodeRows } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import type { DerivedMoveLine } from "./holder-moves.ts"
import { type HoldersWindow, readFrom } from "./holders-window.ts"
import { inserts, monthRows } from "./month-replace.ts"

// A stock that may have moved in the period, the oldest of the periods read
// its read starts at, and its rows from then.
const MovedStock = Schema.Struct({
  stock_code: StockCode,
  since: WibDate,
  rows: Schema.Number,
})
export type MovedStock = typeof MovedStock.Type

// A stock's line, as derived and stored.
export type StockMoveLine = Omit<DerivedMoveLine, "code" | "issuerName">

// One kind's parsed periods, what it derives from them and how.
export interface MovesSource<Rows> {
  // Bumped whenever deriving changes what it stores: the run then derives
  // every period again.
  readonly version: number
  // The periods of a stock its lines are derived from, as its panel reads
  // them; a read of stocks holds at most its budget's rows.
  readonly window: HoldersWindow
  // Its lines' table; `${lines}_pending` stages them.
  readonly lines: string
  // Its derived periods' table: data_date, against and basis.
  readonly derived: string
  // CTEs ending in `moved AS (SELECT stock_code …)`: the stocks whose
  // holders may have moved in ?1 against ?2.
  readonly moved: string
  // `stocks`' rows, each from its since through `period`.
  readonly read: (
    stocks: ReadonlyArray<MovedStock>,
    period: WibDate
  ) => Effect.Effect<Rows, HoldingsDbError, HoldingsDb>
  // A stock's issuer name and lines in `period` from its rows of `read`'s
  // periods, oldest first.
  readonly linesOf: (
    rows: Rows,
    code: StockCode,
    read: ReadonlyArray<WibDate>,
    period: WibDate
  ) => Effect.Effect<{
    readonly issuerName: string
    readonly lines: ReadonlyArray<StockMoveLine>
  }>
}

const ParsedRow = Schema.Struct({
  data_date: WibDate,
  sha256: Schema.String,
  parser_version: Schema.Number,
})
type ParsedRow = typeof ParsedRow.Type

const parsedPeriods = Effect.fnUntraced(function* (table: string) {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT data_date, sha256, parser_version FROM ${table}
        ORDER BY data_date`,
      params: [],
    },
  ])
  return yield* decodeRows(ParsedRow)(rows)
})

// What each of `periods`' lines are derived from, in their order: a digest
// of the derivation's version and of each parsed period up to it. A stock's
// lines read its periods as far back as its window's budget fits, and a
// holder's identity comes from all of them, so a period depends on every
// period before it.
const basesOf = Effect.fnUntraced(function* (
  version: number,
  periods: ReadonlyArray<ParsedRow>
) {
  const encoder = new TextEncoder()
  const bases: Array<string> = []
  let basis = String(version)
  for (const { data_date, sha256, parser_version } of periods) {
    basis = yield* sha256Hex(
      encoder.encode(JSON.stringify([basis, data_date, sha256, parser_version]))
    )
    bases.push(basis)
  }
  return bases
})

const DerivedRow = Schema.Struct({ data_date: WibDate, basis: Schema.String })

// The parsed periods whose lines are missing or derived from another basis,
// oldest first: a period newly parsed or parsed again, and every parsed
// period after it.
export const stalePeriods = Effect.fnUntraced(function* <Rows>(
  source: MovesSource<Rows>
) {
  const periods = yield* parsedPeriods(source.window.parsed)
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    { sql: `SELECT data_date, basis FROM ${source.derived}`, params: [] },
  ])
  const derived = new Map(
    (yield* decodeRows(DerivedRow)(rows)).map(({ data_date, basis }) => [
      data_date,
      basis,
    ])
  )
  const bases = yield* basesOf(source.version, periods)
  return periods.flatMap(({ data_date }, at) =>
    derived.get(data_date) === bases[at] ? [] : [data_date]
  )
})

// The stocks of `source.moved`, each with the oldest period its read starts
// at and its rows from then through ?1: its window up to ?1.
const movedStocks = <Rows>({ moved, window }: MovesSource<Rows>) => `
  WITH ${moved},
  ${readFrom(window, "SELECT stock_code FROM moved", "?1")}
  SELECT stock_code, since, rows FROM read_from ORDER BY stock_code`

// `stocks` in reads, in order, whose rows together fit `budget`; each
// stock's own rows fit it, as movedStocks reads them.
const readsOf = (stocks: ReadonlyArray<MovedStock>, budget: number) =>
  Effect.sync(() => {
    const reads: Array<Array<MovedStock>> = []
    let rows = Infinity
    for (const stock of stocks) {
      if (rows + stock.rows > budget) {
        reads.push([])
        rows = 0
      }
      reads.at(-1)?.push(stock)
      rows += stock.rows
    }
    return reads
  })

// A read's stocks, ?1 a JSON array of [code, since], each from its since
// through ?2.
export const WANT = `
  WITH want AS (
    SELECT value->>0 AS stock_code, value->>1 AS since FROM json_each(?1)
  )`

// Rows as read, by their stock code: a read's rows are decoded only as each
// stock is derived, so it is held decoded one stock at a time.
export const byStock = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Effect.sync(() => {
    const of = new Map<string, Array<Record<string, unknown>>>()
    for (const row of rows) {
      const code = String(row["stock_code"])
      const held = of.get(code)
      if (held === undefined) of.set(code, [row])
      else held.push(row)
    }
    return of
  })

// The columns of a lines row after its date, in order.
const MOVE_COLUMNS = [
  "stock_code",
  "holder",
  "issuer_name",
  "name",
  "aliases",
  "renamed_from",
  "move",
  "through",
  "share_change",
  "stake_before",
  "stake_now",
  "percentage_change",
  "trend",
]
const MOVE_ROW = ["data_date", ...MOVE_COLUMNS].join(", ")

const moveRow = (code: StockCode, issuerName: string, line: StockMoveLine) =>
  Effect.succeed([
    code,
    line.holder,
    issuerName,
    line.name,
    JSON.stringify(line.aliases),
    line.renamedFrom ?? null,
    line.move,
    JSON.stringify(line.custodians),
    line.shareChange ?? null,
    line.stake.before ?? null,
    line.stake.now ?? null,
    line.percentageChange ?? null,
    JSON.stringify(line.trend),
  ])

// Stages the lines of `period` of `stocks`, read together, each from its
// since. Its own function, so a read's rows and lines are gone before the
// next read's. The number of lines.
const stageStockLines = Effect.fnUntraced(function* <Rows>(
  source: MovesSource<Rows>,
  stocks: ReadonlyArray<MovedStock>,
  read: ReadonlyArray<WibDate>,
  period: WibDate
) {
  const rows = yield* source.read(stocks, period)
  const staged = yield* monthRows(`${source.lines}_pending`, MOVE_COLUMNS)
  let count = 0
  for (const { stock_code: code, since } of stocks) {
    const { issuerName, lines } = yield* source.linesOf(
      rows,
      code,
      read.filter((each) => each >= since),
      period
    )
    for (const line of lines) {
      yield* staged.add(yield* moveRow(code, issuerName, line))
      count += 1
    }
  }
  const statements = yield* inserts("data_date", period, yield* staged.gathered)
  if (statements.length > 0) yield* (yield* HoldingsDb).batch(statements)
  return count
})

// Replaces `period`'s lines with those derived from its parsed periods now,
// and records its basis. Each stock that may have moved in it is read with
// its window's periods up to it, at most the window's budget of rows at
// once, and its lines staged; one batch then swaps the staged lines in, so a
// reader, or a failed attempt, sees the period's lines whole. The number of
// lines.
export const derivePeriod = Effect.fnUntraced(function* <Rows>(
  source: MovesSource<Rows>,
  period: WibDate
) {
  const db = yield* HoldingsDb
  const periods = yield* parsedPeriods(source.window.parsed)
  const at = periods.findIndex(({ data_date }) => data_date === period)
  const basis = (yield* basesOf(source.version, periods))[at]
  if (basis === undefined) return 0
  const read = periods.slice(0, at + 1).map(({ data_date }) => data_date)
  const against = read.at(-2)
  const pending = `${source.lines}_pending`
  // What an earlier attempt staged is gone first.
  const [, stockRows = []] = yield* db.batch([
    { sql: `DELETE FROM ${pending} WHERE data_date = ?`, params: [period] },
    ...(against === undefined
      ? []
      : [
          {
            sql: movedStocks(source),
            params: [period, against],
          },
        ]),
  ])
  let count = 0
  for (const stocks of yield* readsOf(
    yield* decodeRows(MovedStock)(stockRows),
    source.window.budget
  ))
    count += yield* stageStockLines(source, stocks, read, period)
  yield* db.batch([
    {
      sql: `DELETE FROM ${source.lines} WHERE data_date = ?`,
      params: [period],
    },
    {
      sql: `INSERT INTO ${source.lines} (${MOVE_ROW})
        SELECT ${MOVE_ROW} FROM ${pending} WHERE data_date = ?`,
      params: [period],
    },
    { sql: `DELETE FROM ${pending} WHERE data_date = ?`, params: [period] },
    {
      sql: `INSERT INTO ${source.derived} (data_date, against, basis)
        VALUES (?, ?, ?)
        ON CONFLICT (data_date) DO UPDATE SET
          against = excluded.against, basis = excluded.basis`,
      params: [period, against ?? null, basis],
    },
  ])
  return count
})
