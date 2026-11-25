// The Holder moves page's read (spec apinrdw/kumora#673, "Reading";
// apinrdw/kumora#679, #680): for one period of one kind, the stocks whose
// holders may have moved on it or on one of the rail's periods, each with
// the periods its moves and trends need. The Holder moves view model
// (lib/holder-moves.ts) finds the moves in them by the rules Daily holders
// (a trading day) or Major holders (an above-1% month) uses.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  type MoveKind,
  type MovesSelection,
  RAIL_PERIODS,
  TREND_PERIODS,
} from "@/domain/holdings"

import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import {
  above1Months,
  Above1HoldingRow,
  Above5AccountRow,
  above5Days,
  Above5HolderRow,
  DailyHoldersDay,
  MajorHoldersMonth,
} from "./stock-page.ts"

// A stock that may have moved, and its parsed days that the page needs,
// oldest first: whole runs of consecutive parsed days, each ending at the
// selected day or a rail day. A day without a block of it has none.
const MovesStock = Schema.Struct({
  code: StockCode,
  // As the newest of its days prints it.
  issuerName: Schema.String,
  days: Schema.Array(DailyHoldersDay),
})
export type MovesStock = typeof MovesStock.Type

// A stock that may have moved, and its above-1% months the page needs,
// oldest first, as the Daily stock's days are. A month without a row of it
// has no holders.
const MonthlyMovesStock = Schema.Struct({
  code: StockCode,
  // As the newest of its months prints it.
  issuerName: Schema.String,
  months: Schema.Array(MajorHoldersMonth),
})
export type MonthlyMovesStock = typeof MonthlyMovesStock.Type

const readOf = <K extends MoveKind, S extends Schema.Top>(kind: K, stock: S) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    // Every parsed period's data date, oldest first.
    periods: Schema.Array(WibDate),
    // The period asked for when parsed, else the newest; undefined when
    // none is parsed.
    period: Schema.UndefinedOr(WibDate),
    stocks: Schema.Array(stock),
  })
const DailyMovesRead = readOf("daily", MovesStock)
const MonthlyMovesRead = readOf("monthly", MonthlyMovesStock)
export type HolderMovesRead =
  | typeof DailyMovesRead.Type
  | typeof MonthlyMovesRead.Type

// The (stock, period) pairs a kind's read needs, as the CTE `need`. ?1 is
// the period asked for, or NULL. `table` lists the kind's parsed periods,
// and `match` is true of the one asked for. `mark` defines the CTE `mark`:
// each stock's marks in each period of `marked`, a row per mark, `columns`
// after (data_date, stock_code). A stock may have moved in a period when
// its marks differ from the period before's, and `moved` narrows those.
// Only those stocks' periods are read: the selected period's TREND_PERIODS
// before it for its movers' trends, and each rail period's period before
// for its counts.
const needOf = ({
  table,
  match,
  mark,
  columns,
  moved,
}: {
  readonly table: string
  readonly match: string
  readonly mark: string
  readonly columns: ReadonlyArray<string>
  readonly moved: string
}) => {
  const marks = columns.map((column) => `m.${column}`).join(", ")
  return `
  WITH period AS (
    SELECT data_date, LAG(data_date) OVER (ORDER BY data_date) AS prev
    FROM ${table}
  ),
  selected AS (
    SELECT COALESCE(
      (SELECT data_date FROM ${table} WHERE ${match}),
      (SELECT MAX(data_date) FROM ${table})
    ) AS data_date
  ),
  paired AS (
    SELECT data_date, prev,
      ROW_NUMBER() OVER (ORDER BY data_date DESC) AS age
    FROM period WHERE prev IS NOT NULL
  ),
  shown AS (
    SELECT data_date, prev FROM paired
    WHERE age <= ${RAIL_PERIODS}
      OR data_date = (SELECT data_date FROM selected)
  ),
  marked AS (SELECT data_date FROM shown UNION SELECT prev FROM shown),
  ${mark},
  now_mark AS (
    SELECT s.data_date, m.stock_code, ${marks}
    FROM shown s JOIN mark m ON m.data_date = s.data_date
  ),
  prev_mark AS (
    SELECT s.data_date, m.stock_code, ${marks}
    FROM shown s JOIN mark m ON m.data_date = s.prev
  ),
  changed AS (
    SELECT data_date, stock_code
    FROM (SELECT * FROM now_mark EXCEPT SELECT * FROM prev_mark)
    UNION
    SELECT data_date, stock_code
    FROM (SELECT * FROM prev_mark EXCEPT SELECT * FROM now_mark)
  ),
  moved AS (${moved}),
  trend AS (
    SELECT data_date FROM ${table}
    WHERE data_date <= (SELECT data_date FROM selected)
    ORDER BY data_date DESC LIMIT ${TREND_PERIODS + 1}
  ),
  need AS (
    SELECT m.stock_code, s.data_date
    FROM moved m JOIN shown s USING (data_date)
    UNION
    SELECT m.stock_code, s.prev FROM moved m JOIN shown s USING (data_date)
    UNION
    SELECT m.stock_code, t.data_date FROM moved m, trend t
    WHERE m.data_date = (SELECT data_date FROM selected)
  )`
}

// A stock's above-5% day is marked by its blocks (by place in the
// stock-day, key and shares) and their accounts (custodian, name and
// shares): when none differ from the day before's, the day's holders,
// collapsed and matched, are the day before's, each unchanged.
const DAILY_NEED = needOf({
  table: "above_5_day",
  match: "data_date = ?1",
  mark: `block AS (
    SELECT data_date, stock_code, no, holder_key, scripless,
      ROW_NUMBER() OVER (
        PARTITION BY data_date, stock_code ORDER BY no
      ) AS place
    FROM above_5_holder
    WHERE data_date IN (SELECT data_date FROM marked)
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
  )`,
  columns: ["place", "a", "b", "scripless", "n"],
  moved: "SELECT * FROM changed",
})

// A stock's above-1% month is marked by its holders by holder key and
// summed %, Major holders' change rule. It may have moved only with rows in
// both months: otherwise each is unchanged, or the month before is a gap.
const MONTHLY_NEED = needOf({
  table: "above_1_month",
  match: "substr(data_date, 1, 7) = ?1",
  mark: `mark AS (
    SELECT data_date, stock_code, holder_key,
      SUM(percentage_hundredths) AS hundredths
    FROM above_1_holding
    WHERE data_date IN (SELECT data_date FROM marked)
    GROUP BY data_date, stock_code, holder_key
  )`,
  columns: ["holder_key", "hundredths"],
  moved: `SELECT * FROM changed
    INTERSECT SELECT data_date, stock_code FROM now_mark
    INTERSECT SELECT data_date, stock_code FROM prev_mark`,
})

const byStock = <R extends { readonly stock_code: StockCode }>(
  rows: ReadonlyArray<R>
) =>
  Effect.sync(() => {
    const grouped = new Map<StockCode, Array<R>>()
    for (const row of rows)
      grouped.set(row.stock_code, [...(grouped.get(row.stock_code) ?? []), row])
    return grouped
  })

const PeriodRow = Schema.Struct({ data_date: WibDate })
const NeedRow = Schema.Struct({ stock_code: StockCode, data_date: WibDate })

// In one batch, so a parse run replacing a period mid-read can't mix two
// versions of it: every parsed period of `table`, each stock's needed
// periods by `need` (DAILY_NEED or MONTHLY_NEED) for `asked`, and the rows
// each of `reads` selects from `need`, decoded by `schemas`.
const movesBatch = Effect.fnUntraced(function* <
  const S extends ReadonlyArray<Schema.Codec<unknown>>,
>(
  table: string,
  need: string,
  asked: string | undefined,
  reads: { readonly [I in keyof S]: string },
  schemas: S
) {
  const [periodRows = [], needRows = [], ...rows] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: `SELECT data_date FROM ${table} ORDER BY data_date`,
        params: [],
      },
      {
        sql: `${need} SELECT stock_code, data_date FROM need
          ORDER BY stock_code, data_date`,
        params: [asked ?? null],
      },
      ...reads.map((sql) => ({
        sql: `${need} ${sql}`,
        params: [asked ?? null],
      })),
    ])
  return {
    periods: Schema.decodeUnknownSync(Schema.Array(PeriodRow))(periodRows).map(
      ({ data_date }) => data_date
    ),
    needed: yield* byStock(
      Schema.decodeUnknownSync(Schema.Array(NeedRow))(needRows)
    ),
    rows: schemas.map((schema, at) =>
      Schema.decodeUnknownSync(Schema.Array(schema))(rows[at] ?? [])
    ) as { readonly [I in keyof S]: ReadonlyArray<S[I]["Type"]> },
  }
})

const Above5HolderOfStock = Schema.Struct({
  ...Above5HolderRow.fields,
  stock_code: StockCode,
})
const Above5AccountOfStock = Schema.Struct({
  ...Above5AccountRow.fields,
  stock_code: StockCode,
})

// The parsed above-5% days, and for `day` (undefined for the newest) the
// stocks that may have moved on it or on a rail day. Its rows are at most
// the selected day's TREND_PERIODS + 1 and the rail's RAIL_PERIODS + 1 days
// of the moving stocks' blocks and accounts.
const dailyMovesRead = Effect.fnUntraced(function* (day: WibDate | undefined) {
  const {
    periods,
    needed,
    rows: [holders, accounts],
  } = yield* movesBatch(
    "above_5_day",
    DAILY_NEED,
    day,
    [
      `SELECT h.stock_code, h.data_date, h.no, h.issuer_name, h.holder_name,
        h.holder_key, h.scripless, h.percentage_hundredths
      FROM above_5_holder h JOIN need USING (stock_code, data_date)
      ORDER BY h.stock_code, h.data_date, h.no`,
      `SELECT a.stock_code, a.data_date, a.no, a.custodian, a.account_name,
        a.origin, a.domicile, a.scripless
      FROM above_5_account a JOIN need USING (stock_code, data_date)
      ORDER BY a.stock_code, a.data_date, a.no, a.ordinal`,
    ],
    [Above5HolderOfStock, Above5AccountOfStock]
  )
  const holdersOf = yield* byStock(holders)
  const accountsOf = yield* byStock(accounts)
  const stocks = yield* Effect.forEach(
    needed,
    Effect.fnUntraced(function* ([code, days]) {
      const blocks = holdersOf.get(code) ?? []
      return {
        code,
        issuerName: blocks.at(-1)?.issuer_name ?? "",
        days: yield* above5Days(
          days.map(({ data_date }) => ({ data_date, listed_shares: null })),
          blocks,
          accountsOf.get(code) ?? []
        ),
      } satisfies MovesStock
    })
  )
  return DailyMovesRead.make({
    kind: "daily",
    periods,
    period: periods.find((each) => each === day) ?? periods.at(-1),
    stocks,
  })
})

const Above1HoldingOfStock = Schema.Struct({
  ...Above1HoldingRow.fields,
  stock_code: StockCode,
  issuer_name: Schema.String,
})

// The parsed above-1% months, and for `month` (undefined for the newest)
// the stocks that may have moved in it or in a rail month.
const monthlyMovesRead = Effect.fnUntraced(function* (
  month: string | undefined
) {
  const {
    periods,
    needed,
    rows: [holdings],
  } = yield* movesBatch(
    "above_1_month",
    MONTHLY_NEED,
    month,
    [
      `SELECT h.stock_code, h.data_date, h.issuer_name, h.holder_key,
        h.investor_name, h.classification, h.investor_type, h.origin,
        h.domicile, h.controller, h.scripless, h.scrip, h.total,
        h.percentage_hundredths
      FROM above_1_holding h JOIN need USING (stock_code, data_date)
      ORDER BY h.stock_code, h.data_date, h.seq`,
    ],
    [Above1HoldingOfStock]
  )
  const holdingsOf = yield* byStock(holdings)
  const stocks = yield* Effect.forEach(
    needed,
    Effect.fnUntraced(function* ([code, months]) {
      const rows = holdingsOf.get(code) ?? []
      return {
        code,
        issuerName: rows.at(-1)?.issuer_name ?? "",
        months: yield* above1Months(months, rows),
      } satisfies MonthlyMovesStock
    })
  )
  return MonthlyMovesRead.make({
    kind: "monthly",
    periods,
    period:
      periods.find((each) => each.slice(0, 7) === month) ?? periods.at(-1),
    stocks,
  })
})

// The periods the selection's kind has parsed, and for its period (the
// newest when absent) the stocks that may have moved in it or in a rail
// period.
export const holderMovesRead = (
  selection: MovesSelection
): Effect.Effect<HolderMovesRead, HoldingsDbError, HoldingsDb> =>
  selection.kind === "daily"
    ? dailyMovesRead(selection.day)
    : monthlyMovesRead(selection.month)
