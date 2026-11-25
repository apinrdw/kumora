// Holder moves' Daily lines, derived from the parsed above-5% days
// (holdings-migrations/0011_above_5_move.sql): the above-5% parse run, after
// parsing its days, derives each day whose basis changed, so the Holder
// moves page reads one day's lines (holder-moves.ts). A day's lines are each
// moving stock's Daily holders movers on it (lib/daily-holders.ts), the same
// view model the stock page runs, from the stock's days its Trend needs.
// Spec apinrdw/kumora#673, "Holder moves".
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { TREND_PERIODS } from "@/domain/holdings"
import {
  type DailyHolderLine,
  dailyHolders,
  movedCustodians,
} from "@/lib/daily-holders"

import { decodeRows } from "../d1.ts"
import { HoldingsDb } from "./db.ts"
import { inserts, monthRows } from "./month-replace.ts"
import {
  Above5AccountRow,
  above5Days,
  Above5HolderRow,
  DAILY_HOLDERS_ROWS,
} from "./stock-page.ts"

// Bumped whenever deriving changes what it stores, TREND_RUN or
// DAILY_HOLDERS_ROWS included: the run then derives every day again.
const HOLDER_MOVES_VERSION = 1

// A day's lines read the day itself, the trend's other days before it, and
// the one before those for the oldest bar.
const TREND_RUN = TREND_PERIODS + 1

const ParsedDayRow = Schema.Struct({
  data_date: WibDate,
  sha256: Schema.String,
  parser_version: Schema.Number,
})
type ParsedDayRow = typeof ParsedDayRow.Type

const parsedDays = Effect.fnUntraced(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT data_date, sha256, parser_version FROM above_5_day ORDER BY data_date",
      params: [],
    },
  ])
  return yield* decodeRows(ParsedDayRow)(rows)
})

// The parsed days a day's lines read, oldest first, and what they were
// derived from: the derivation's version and each of those days' version.
const basisOf = (days: ReadonlyArray<ParsedDayRow>, at: number) =>
  Effect.sync(() => {
    const read = days.slice(Math.max(0, at - TREND_RUN + 1), at + 1)
    return {
      read: read.map(({ data_date }) => data_date),
      basis: JSON.stringify([
        HOLDER_MOVES_VERSION,
        read.map(({ data_date, sha256, parser_version }) => [
          data_date,
          sha256,
          parser_version,
        ]),
      ]),
    }
  })

const DerivedDayRow = Schema.Struct({
  data_date: WibDate,
  basis: Schema.String,
})

// The parsed days whose lines are missing or derived from another basis,
// oldest first: a day newly parsed or parsed again, and the TREND_PERIODS
// parsed days after it, whose Trends read it.
export const staleMoveDays = Effect.fnUntraced(function* () {
  const days = yield* parsedDays()
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    { sql: "SELECT data_date, basis FROM above_5_move_day", params: [] },
  ])
  const derived = new Map(
    (yield* decodeRows(DerivedDayRow)(rows)).map(({ data_date, basis }) => [
      data_date,
      basis,
    ])
  )
  const stale: Array<WibDate> = []
  for (const [at, { data_date }] of days.entries())
    if (derived.get(data_date) !== (yield* basisOf(days, at)).basis)
      stale.push(data_date)
  return stale
})

// Decision: Daily holders reads the stock's newest above-5% days that fit
// a row budget (apps/dashboard/docs/adr/0133-daily-holders-reads-the-newest-days-that-fit-a-row-budget.md)
//
// The stocks whose holders may have moved on ?2 against ?3, each with the
// oldest of the days ?1 (a JSON array, oldest first, ending at ?2) its read
// starts at: its newest days whose rows fit DAILY_HOLDERS_ROWS, as the
// stock page reads them. A stock-day's marks are its blocks (by place,
// key and shares) and their accounts (custodian, name and shares): when
// none differ from the day before's, the day's holders, collapsed and
// matched, are the day before's, each unchanged.
const MOVED_STOCKS = `
  WITH block AS (
    SELECT data_date, stock_code, no, holder_key, scripless,
      ROW_NUMBER() OVER (
        PARTITION BY data_date, stock_code ORDER BY no
      ) AS place
    FROM above_5_holder
    WHERE data_date IN (?2, ?3)
  ),
  mark AS (
    SELECT data_date, stock_code, place, a, b, scripless, COUNT(*) AS n
    FROM (
      SELECT data_date, stock_code, place, holder_key AS a, NULL AS b,
        scripless
      FROM block
      UNION ALL
      SELECT k.data_date, k.stock_code, k.place, x.custodian, x.account_name,
        x.scripless
      FROM block k JOIN above_5_account x USING (data_date, stock_code, no)
    )
    GROUP BY data_date, stock_code, place, a, b, scripless
  ),
  now_mark AS (
    SELECT stock_code, place, a, b, scripless, n FROM mark
    WHERE data_date = ?2
  ),
  prev_mark AS (
    SELECT stock_code, place, a, b, scripless, n FROM mark
    WHERE data_date = ?3
  ),
  moved AS (
    SELECT stock_code
    FROM (SELECT * FROM now_mark EXCEPT SELECT * FROM prev_mark)
    UNION
    SELECT stock_code
    FROM (SELECT * FROM prev_mark EXCEPT SELECT * FROM now_mark)
  ),
  cost AS (
    SELECT m.stock_code, d.value AS data_date, 1 + (
      SELECT COUNT(*) FROM above_5_holder h
      WHERE h.stock_code = m.stock_code AND h.data_date = d.value
    ) + (
      SELECT COUNT(*) FROM above_5_account a
      WHERE a.stock_code = m.stock_code AND a.data_date = d.value
    ) AS rows
    FROM moved m, json_each(?1) d
  )
  SELECT stock_code, MIN(data_date) AS since, SUM(rows) AS rows
  FROM (
    SELECT stock_code, data_date, rows,
      SUM(rows) OVER (
        PARTITION BY stock_code ORDER BY data_date DESC
      ) AS total
    FROM cost
  )
  WHERE total <= ${DAILY_HOLDERS_ROWS}
  GROUP BY stock_code
  ORDER BY stock_code`

const MovedStockRow = Schema.Struct({
  stock_code: StockCode,
  since: WibDate,
  rows: Schema.Number,
})
type MovedStockRow = typeof MovedStockRow.Type

// A read's stocks, ?1 a JSON array of [code, since], each from its since
// through ?2.
const WANT = `
  WITH want AS (
    SELECT value->>0 AS stock_code, value->>1 AS since FROM json_each(?1)
  )`
const HOLDERS = `${WANT}
  SELECT h.stock_code, h.data_date, h.no, h.issuer_name, h.holder_name,
    h.holder_key, h.scripless, h.percentage_hundredths
  FROM above_5_holder h JOIN want w ON h.stock_code = w.stock_code
  WHERE h.data_date >= w.since AND h.data_date <= ?2
  ORDER BY h.stock_code, h.data_date, h.no`
const ACCOUNTS = `${WANT}
  SELECT a.stock_code, a.data_date, a.no, a.custodian, a.account_name,
    a.origin, a.domicile, a.scripless
  FROM above_5_account a JOIN want w ON a.stock_code = w.stock_code
  WHERE a.data_date >= w.since AND a.data_date <= ?2
  ORDER BY a.stock_code, a.data_date, a.no, a.ordinal`

const HolderOfStock = Schema.Struct({
  ...Above5HolderRow.fields,
  stock_code: StockCode,
})
const AccountOfStock = Schema.Struct({
  ...Above5AccountRow.fields,
  stock_code: StockCode,
})

// `stocks` in runs, in order, whose rows together fit DAILY_HOLDERS_ROWS;
// each stock's own rows fit it, as MOVED_STOCKS reads them.
const readsOf = (stocks: ReadonlyArray<MovedStockRow>) =>
  Effect.sync(() => {
    const reads: Array<Array<MovedStockRow>> = []
    let rows = Infinity
    for (const stock of stocks) {
      if (rows + stock.rows > DAILY_HOLDERS_ROWS) {
        reads.push([])
        rows = 0
      }
      reads.at(-1)?.push(stock)
      rows += stock.rows
    }
    return reads
  })

// Rows as read, by their stock code.
const byStock = (rows: ReadonlyArray<Record<string, unknown>>) =>
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

// The columns of an above_5_move row after its date, in order.
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

// A Daily holders line of the day, when it moved: listed with a move other
// than Unchanged, or on the day's Off list.
const moveRow = Effect.fnUntraced(function* (
  code: StockCode,
  issuerName: string,
  line: DailyHolderLine
) {
  const { move } = line
  if (move === undefined || move === "unchanged") return undefined
  return [
    code,
    line.holder,
    issuerName,
    line.name,
    JSON.stringify(line.aliases),
    line.renamedFrom ?? null,
    move,
    JSON.stringify(yield* movedCustodians(line.accounts)),
    line.shareChange ?? null,
    line.stake.before ?? null,
    line.stake.now ?? null,
    line.percentageChange ?? null,
    JSON.stringify(line.trend),
  ]
})

// The rows of `stocks`' blocks and accounts, each from its since through
// `day`, by stock, as read: each stock's are decoded only when it is
// derived, so a read is held decoded one stock at a time.
const readStocks = Effect.fnUntraced(function* (
  stocks: ReadonlyArray<MovedStockRow>,
  day: WibDate
) {
  const want = JSON.stringify(
    stocks.map(({ stock_code, since }) => [stock_code, since])
  )
  const [holderRows = [], accountRows = []] = yield* (yield* HoldingsDb).batch([
    { sql: HOLDERS, params: [want, day] },
    { sql: ACCOUNTS, params: [want, day] },
  ])
  return {
    holders: yield* byStock(holderRows),
    accounts: yield* byStock(accountRows),
  }
})

// Stages the lines of `day` of `stocks`, read together, each from its
// since, in above_5_move_pending. Its own function, so a read's rows and
// lines are gone before the next read's. The number of lines.
const stageStockLines = Effect.fnUntraced(function* (
  stocks: ReadonlyArray<MovedStockRow>,
  read: ReadonlyArray<WibDate>,
  day: WibDate
) {
  const rows = yield* readStocks(stocks, day)
  const lines = yield* monthRows("above_5_move_pending", MOVE_COLUMNS)
  let count = 0
  for (const { stock_code: code, since } of stocks) {
    const blocks = yield* decodeRows(HolderOfStock)(
      rows.holders.get(code) ?? []
    )
    const held = yield* dailyHolders(
      yield* above5Days(
        read
          .filter((each) => each >= since)
          .map((data_date) => ({ data_date, listed_shares: null })),
        blocks,
        yield* decodeRows(AccountOfStock)(rows.accounts.get(code) ?? [])
      ),
      day
    )
    if (held?.dataDate !== day) continue
    const issuerName = blocks.at(-1)?.issuer_name ?? ""
    for (const line of [...held.listed, ...held.offList]) {
      const row = yield* moveRow(code, issuerName, line)
      if (row === undefined) continue
      yield* lines.add(row)
      count += 1
    }
  }
  const statements = yield* inserts("data_date", day, yield* lines.gathered)
  if (statements.length > 0) yield* (yield* HoldingsDb).batch(statements)
  return count
})

const MOVE_ROW = ["data_date", ...MOVE_COLUMNS].join(", ")

// Replaces `day`'s lines with those derived from its parsed days now, and
// records its basis. Each stock that may have moved on it is read with as
// many of its days as its Trend reads, at most DAILY_HOLDERS_ROWS of rows at
// once, and its lines staged; one batch then swaps the staged lines in, so
// a reader, or a failed attempt, sees the day's lines whole. The number of
// lines.
export const deriveMoveDay = Effect.fnUntraced(function* (day: WibDate) {
  const db = yield* HoldingsDb
  const days = yield* parsedDays()
  const at = days.findIndex(({ data_date }) => data_date === day)
  if (at === -1) return 0
  const { read, basis } = yield* basisOf(days, at)
  const against = read.at(-2)
  // What an earlier attempt staged is gone first.
  const [, stockRows = []] = yield* db.batch([
    {
      sql: "DELETE FROM above_5_move_pending WHERE data_date = ?",
      params: [day],
    },
    ...(against === undefined
      ? []
      : [{ sql: MOVED_STOCKS, params: [JSON.stringify(read), day, against] }]),
  ])
  let count = 0
  for (const stocks of yield* readsOf(
    yield* decodeRows(MovedStockRow)(stockRows)
  ))
    count += yield* stageStockLines(stocks, read, day)
  yield* db.batch([
    { sql: "DELETE FROM above_5_move WHERE data_date = ?", params: [day] },
    {
      sql: `INSERT INTO above_5_move (${MOVE_ROW})
        SELECT ${MOVE_ROW} FROM above_5_move_pending WHERE data_date = ?`,
      params: [day],
    },
    {
      sql: "DELETE FROM above_5_move_pending WHERE data_date = ?",
      params: [day],
    },
    {
      sql: `INSERT INTO above_5_move_day (data_date, against, basis)
        VALUES (?, ?, ?)
        ON CONFLICT (data_date) DO UPDATE SET
          against = excluded.against, basis = excluded.basis`,
      params: [day, against ?? null, basis],
    },
  ])
  return count
})
