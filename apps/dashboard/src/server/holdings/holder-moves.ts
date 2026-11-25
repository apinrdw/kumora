// The Holder moves page's read (spec apinrdw/kumora#673, "Reading";
// apinrdw/kumora#679, #680): for one period of one kind, its moves and the
// rail's counts, as the kind's parse run derived them (derived-moves.ts): a
// trading day's by Daily holders' rules (above-5-moves.ts), an above-1%
// month's by Major holders' (above-1-moves.ts).
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  MOVE_KINDS,
  type MoveKind,
  type MovesSelection,
  RAIL_PERIODS,
} from "@/domain/holdings"

import { decodeRows } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"

// A holder that moved in the selected period, as Holder moves' derivation
// stored it (derived-moves.ts).
const DerivedMoveLine = Schema.Struct({
  code: StockCode,
  issuerName: Schema.String,
  holder: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  renamedFrom: Schema.UndefinedOr(Schema.String),
  move: Schema.Literals(["new", "up", "down", "off list"]),
  // The custodians of the securities accounts the move went through,
  // largest change first; the view model looks up their broker codes. None
  // on a month.
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
export type DerivedMoveLine = typeof DerivedMoveLine.Type

const MoveCounts = Schema.Struct({
  new: Schema.Number,
  up: Schema.Number,
  down: Schema.Number,
  offList: Schema.Number,
})

const HolderMovesRead = Schema.Struct({
  kind: Schema.Literals(MOVE_KINDS),
  // Every derived period the kind shows, oldest first: a month's newest
  // report.
  periods: Schema.Array(WibDate),
  // The period asked for when derived, a month's being its newest report,
  // else the newest; undefined when there is none.
  period: Schema.UndefinedOr(WibDate),
  // The period the moves are against; undefined on the first parsed one.
  against: Schema.UndefinedOr(WibDate),
  lines: Schema.Array(DerivedMoveLine),
  // The last RAIL_PERIODS periods with one before, oldest first.
  rail: Schema.Array(Schema.Struct({ period: WibDate, counts: MoveCounts })),
})
export type HolderMovesRead = typeof HolderMovesRead.Type

const MoveRow = Schema.Struct({
  stock_code: StockCode,
  holder: Schema.String,
  issuer_name: Schema.String,
  name: Schema.String,
  aliases: Schema.fromJsonString(Schema.Array(Schema.String)),
  renamed_from: Schema.NullOr(Schema.String),
  move: DerivedMoveLine.fields.move,
  through: Schema.fromJsonString(Schema.Array(Schema.String)),
  share_change: Schema.NullOr(Schema.Number),
  stake_before: Schema.NullOr(Schema.Number),
  stake_now: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
  trend: Schema.fromJsonString(DerivedMoveLine.fields.trend),
})

const DerivedRow = Schema.Struct({
  data_date: WibDate,
  against: Schema.NullOr(WibDate),
  selected: Schema.BooleanFromBit,
})

const RailRow = Schema.Struct({
  data_date: WibDate,
  move: DerivedMoveLine.fields.move,
  lines: Schema.Number,
})

// Each kind's derived lines (derived-moves.ts); the derived periods it
// shows, the CTE `periods`; and how an asked-for period, ?1, matches a
// shown one's date: a trading day by itself, a month (`YYYY-MM`) by the
// date's month.
const KINDS = {
  daily: {
    lines: "above_5_move",
    periods: "SELECT data_date, against FROM above_5_move_day",
    match: "data_date = ?1",
  },
  monthly: {
    lines: "above_1_move",
    // Decision: a calendar month with two reports shows its newest
    // (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
    periods: `SELECT data_date, against FROM above_1_move_month
      WHERE data_date IN (
        SELECT MAX(data_date) FROM above_1_move_month
        GROUP BY substr(data_date, 1, 7)
      )`,
    match: "substr(data_date, 1, 7) = ?1",
  },
} satisfies Record<
  MoveKind,
  {
    readonly lines: string
    readonly periods: string
    readonly match: string
  }
>

// The CTE `selected`: the one shown period the read shows, the one that
// matches ?1, else the newest. The period's lines and its date both come
// from it.
const SELECTED = (match: string) => `
  selected AS (
    SELECT COALESCE(
      (SELECT MAX(data_date) FROM periods WHERE ${match}),
      (SELECT MAX(data_date) FROM periods)
    ) AS data_date
  )`

// The shown periods, and for `asked` (undefined for the newest) its
// stored lines and the rail's counts of theirs, in one batch, so a parse
// run deriving a period mid-read can't mix two versions of it. The read is
// one period's lines and one count per rail period and move.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
const derivedMovesRead = Effect.fnUntraced(function* (
  kind: MoveKind,
  asked: string | undefined
) {
  const { lines, periods: shownPeriods, match } = KINDS[kind]
  const withPeriods = `WITH periods AS (${shownPeriods})`
  const withSelected = `${withPeriods}, ${SELECTED(match)}`
  const [periodRows = [], lineRows = [], railRows = []] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: `${withSelected}
        SELECT data_date, against,
          data_date = (SELECT data_date FROM selected) AS selected
        FROM periods ORDER BY data_date`,
        params: [asked ?? null],
      },
      {
        sql: `${withSelected}
        SELECT stock_code, holder, issuer_name, name, aliases, renamed_from,
          move, through, share_change, stake_before, stake_now,
          percentage_change, trend
        FROM ${lines} WHERE data_date = (SELECT data_date FROM selected)
        ORDER BY stock_code, holder`,
        params: [asked ?? null],
      },
      {
        sql: `${withPeriods}
        SELECT data_date, move, COUNT(*) AS lines FROM ${lines}
        WHERE data_date IN (
          SELECT data_date FROM periods WHERE against IS NOT NULL
          ORDER BY data_date DESC LIMIT ${RAIL_PERIODS}
        )
        GROUP BY data_date, move`,
        params: [],
      },
    ])
  const rows = yield* decodeRows(DerivedRow)(periodRows)
  const periods = rows.map(({ data_date }) => data_date)
  const shown = rows.find(({ selected }) => selected)
  const counts = yield* decodeRows(RailRow)(railRows)
  const countOf = (date: WibDate, move: DerivedMoveLine["move"]) =>
    counts.find((each) => each.data_date === date && each.move === move)
      ?.lines ?? 0
  return HolderMovesRead.make({
    kind,
    periods,
    period: shown?.data_date,
    against: shown?.against ?? undefined,
    lines: (yield* decodeRows(MoveRow)(lineRows)).map(
      (row): DerivedMoveLine => ({
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
    rail: rows
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

// The periods the selection's kind shows, and for its period (the newest
// when absent) its moves and the rail's counts.
export const holderMovesRead = (
  selection: MovesSelection
): Effect.Effect<HolderMovesRead, HoldingsDbError, HoldingsDb> =>
  derivedMovesRead(
    selection.kind,
    selection.kind === "daily" ? selection.day : selection.month
  )
