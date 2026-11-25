// The Holder moves page's read (spec apinrdw/kumora#673, "Reading";
// apinrdw/kumora#679, #680): for one period of one kind, its moves and the
// rail's counts. A trading day's are read as the above-5% parse run derived
// them (above-5-moves.ts), by Daily holders' rules. An above-1% month's are
// found by the Holder moves view model (lib/holder-moves.ts), by Major
// holders' rules, in the months read of the stocks whose holders may have
// moved in it or in one of the rail's months.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  type MoveKind,
  type MovesSelection,
  RAIL_PERIODS,
  TREND_PERIODS,
} from "@/domain/holdings"

import { decodeRows } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import {
  above1Months,
  Above1HoldingRow,
  MajorHoldersMonth,
} from "./stock-page.ts"

// A holder that moved on the selected trading day, as Holder moves'
// derivation stored it (above-5-moves.ts).
const DailyMoveLine = Schema.Struct({
  code: StockCode,
  issuerName: Schema.String,
  holder: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  renamedFrom: Schema.UndefinedOr(Schema.String),
  move: Schema.Literals(["new", "up", "down", "off list"]),
  // The custodians of the accounts the move went through, largest change
  // first; the view model looks up their broker codes.
  custodians: Schema.Array(Schema.String),
  shareChange: Schema.UndefinedOr(Schema.Number),
  stake: Schema.Struct({
    before: Schema.optional(Schema.Number),
    now: Schema.optional(Schema.Number),
  }),
  percentageChange: Schema.UndefinedOr(Schema.Number),
  trend: Schema.Array(
    Schema.Union([Schema.Number, Schema.Literals(["in", "out"]), Schema.Null])
  ),
})
export type DailyMoveLine = typeof DailyMoveLine.Type

const MoveCounts = Schema.Struct({
  new: Schema.Number,
  up: Schema.Number,
  down: Schema.Number,
  offList: Schema.Number,
})

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

const readOf = <K extends MoveKind, F extends Schema.Struct.Fields>(
  kind: K,
  fields: F
) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    // Every period with moves to show, oldest first.
    periods: Schema.Array(WibDate),
    // The period asked for when shown, else the newest; undefined when
    // there is none.
    period: Schema.UndefinedOr(WibDate),
    ...fields,
  })
const DailyMovesRead = readOf("daily", {
  // The trading day the moves are against; undefined on the first parsed
  // one.
  against: Schema.UndefinedOr(WibDate),
  lines: Schema.Array(DailyMoveLine),
  // The last RAIL_PERIODS days with one before, oldest first.
  rail: Schema.Array(Schema.Struct({ period: WibDate, counts: MoveCounts })),
})
const MonthlyMovesRead = readOf("monthly", {
  stocks: Schema.Array(MonthlyMovesStock),
})
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
// periods by `need` (MONTHLY_NEED) for `asked`, and the rows
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

const DailyMoveRow = Schema.Struct({
  stock_code: StockCode,
  holder: Schema.String,
  issuer_name: Schema.String,
  name: Schema.String,
  aliases: Schema.fromJsonString(Schema.Array(Schema.String)),
  renamed_from: Schema.NullOr(Schema.String),
  move: DailyMoveLine.fields.move,
  through: Schema.fromJsonString(Schema.Array(Schema.String)),
  share_change: Schema.NullOr(Schema.Number),
  stake_before: Schema.NullOr(Schema.Number),
  stake_now: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
  trend: Schema.fromJsonString(DailyMoveLine.fields.trend),
})

const DerivedDayRow = Schema.Struct({
  data_date: WibDate,
  against: Schema.NullOr(WibDate),
})

const RailRow = Schema.Struct({
  data_date: WibDate,
  move: DailyMoveLine.fields.move,
  lines: Schema.Number,
})

// The days Holder moves' derivation has derived (above-5-moves.ts), ?1 the
// one asked for or NULL, as the CTE `selected`: that day when derived, else
// the newest.
const SELECTED_DAY = `
  WITH selected AS (
    SELECT COALESCE(
      (SELECT data_date FROM above_5_move_day WHERE data_date = ?1),
      (SELECT MAX(data_date) FROM above_5_move_day)
    ) AS data_date
  )`

// The rail's days: the newest RAIL_PERIODS derived days with one before.
const RAIL_DAYS = `
  SELECT data_date FROM above_5_move_day WHERE against IS NOT NULL
  ORDER BY data_date DESC LIMIT ${RAIL_PERIODS}`

// The derived days, and for `day` (undefined for the newest) its stored
// lines and the rail's counts of theirs, in one batch, so a parse run
// deriving a day mid-read can't mix two versions of it. The read is one
// day's lines and one count per rail day and move.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
const dailyMovesRead = Effect.fnUntraced(function* (day: WibDate | undefined) {
  const [dayRows = [], lineRows = [], railRows = []] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: "SELECT data_date, against FROM above_5_move_day ORDER BY data_date",
        params: [],
      },
      {
        sql: `${SELECTED_DAY}
        SELECT stock_code, holder, issuer_name, name, aliases, renamed_from,
          move, through, share_change, stake_before, stake_now,
          percentage_change, trend
        FROM above_5_move WHERE data_date = (SELECT data_date FROM selected)
        ORDER BY stock_code, holder`,
        params: [day ?? null],
      },
      {
        sql: `SELECT data_date, move, COUNT(*) AS lines FROM above_5_move
        WHERE data_date IN (${RAIL_DAYS})
        GROUP BY data_date, move`,
        params: [],
      },
    ])
  const days = yield* decodeRows(DerivedDayRow)(dayRows)
  const periods = days.map(({ data_date }) => data_date)
  const period = periods.find((each) => each === day) ?? periods.at(-1)
  const counts = yield* decodeRows(RailRow)(railRows)
  const countOf = (date: WibDate, move: DailyMoveLine["move"]) =>
    counts.find((each) => each.data_date === date && each.move === move)
      ?.lines ?? 0
  return DailyMovesRead.make({
    kind: "daily",
    periods,
    period,
    against:
      days.find(({ data_date }) => data_date === period)?.against ?? undefined,
    lines: (yield* decodeRows(DailyMoveRow)(lineRows)).map(
      (row): DailyMoveLine => ({
        code: row.stock_code,
        issuerName: row.issuer_name,
        holder: row.holder,
        name: row.name,
        aliases: row.aliases,
        renamedFrom: row.renamed_from ?? undefined,
        move: row.move,
        custodians: row.through,
        shareChange: row.share_change ?? undefined,
        stake: {
          ...(row.stake_before !== null && { before: row.stake_before }),
          ...(row.stake_now !== null && { now: row.stake_now }),
        },
        percentageChange: row.percentage_change ?? undefined,
        trend: row.trend,
      })
    ),
    rail: days
      .filter(({ against }) => against !== null)
      .slice(-RAIL_PERIODS)
      .map(({ data_date }) => ({
        period: data_date,
        counts: {
          new: countOf(data_date, "new"),
          up: countOf(data_date, "up"),
          down: countOf(data_date, "down"),
          offList: countOf(data_date, "off list"),
        },
      })),
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

// The periods the selection's kind shows, and for its period (the newest
// when absent) its moves or the stocks that may have moved in it or in a
// rail period.
export const holderMovesRead = (
  selection: MovesSelection
): Effect.Effect<HolderMovesRead, HoldingsDbError, HoldingsDb> =>
  selection.kind === "daily"
    ? dailyMovesRead(selection.day)
    : monthlyMovesRead(selection.month)
