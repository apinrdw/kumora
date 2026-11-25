// The Holder moves page's read (spec apinrdw/kumora#673, "Reading";
// apinrdw/kumora#679): for one period of one kind, the stocks whose holders
// may have moved on it or on one of the rail's periods, each with the
// periods its moves and trends need. The Holder moves view model
// (lib/holder-moves.ts) finds the moves in them by the rules Daily holders
// uses.
import { StockCode } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { MOVE_KINDS, type MoveKind, RAIL_PERIODS } from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"
import {
  Above5AccountRow,
  above5Days,
  Above5HolderRow,
  DailyHoldersDay,
} from "./stock-page.ts"

// The periods a trend covers, ending at the selected one; its oldest bar
// compares with the period before them.
const TREND_PERIODS = 20

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

const HolderMovesRead = Schema.Struct({
  kind: Schema.Literals(MOVE_KINDS),
  // Every parsed period, oldest first.
  periods: Schema.Array(Schema.String),
  // The period asked for when parsed, else the newest; undefined when none
  // is parsed.
  period: Schema.UndefinedOr(Schema.String),
  stocks: Schema.Array(MovesStock),
})
export type HolderMovesRead = typeof HolderMovesRead.Type

// ?1 is the day asked for, or NULL. A stock may have moved on a day when
// its blocks (by place in the stock-day, key and shares) or their accounts
// (custodian, name and shares) differ from the parsed day before's: when
// none differ, the day's holders, collapsed and matched, are the day
// before's, each unchanged. Only those stocks' days are read: the selected
// day's 20 before it for its movers' trends, and each rail day's day before
// for its counts.
const NEED = `
  WITH day AS (
    SELECT data_date, LAG(data_date) OVER (ORDER BY data_date) AS prev
    FROM above_5_day
  ),
  selected AS (
    SELECT COALESCE(
      (SELECT data_date FROM above_5_day WHERE data_date = ?1),
      (SELECT MAX(data_date) FROM above_5_day)
    ) AS data_date
  ),
  paired AS (
    SELECT data_date, prev,
      ROW_NUMBER() OVER (ORDER BY data_date DESC) AS age
    FROM day WHERE prev IS NOT NULL
  ),
  shown AS (
    SELECT data_date, prev FROM paired
    WHERE age <= ${RAIL_PERIODS}
      OR data_date = (SELECT data_date FROM selected)
  ),
  block AS (
    SELECT data_date, stock_code, no, holder_key, scripless,
      ROW_NUMBER() OVER (
        PARTITION BY data_date, stock_code ORDER BY no
      ) AS place
    FROM above_5_holder
    WHERE data_date IN (SELECT data_date FROM shown UNION SELECT prev FROM shown)
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
    SELECT s.data_date, m.stock_code, m.place, m.a, m.b, m.scripless, m.n
    FROM shown s JOIN mark m ON m.data_date = s.data_date
  ),
  prev_mark AS (
    SELECT s.data_date, m.stock_code, m.place, m.a, m.b, m.scripless, m.n
    FROM shown s JOIN mark m ON m.data_date = s.prev
  ),
  moved AS (
    SELECT data_date, stock_code
    FROM (SELECT * FROM now_mark EXCEPT SELECT * FROM prev_mark)
    UNION
    SELECT data_date, stock_code
    FROM (SELECT * FROM prev_mark EXCEPT SELECT * FROM now_mark)
  ),
  trend_day AS (
    SELECT data_date FROM above_5_day
    WHERE data_date <= (SELECT data_date FROM selected)
    ORDER BY data_date DESC LIMIT ${TREND_PERIODS + 1}
  ),
  need AS (
    SELECT m.stock_code, s.data_date
    FROM moved m JOIN shown s USING (data_date)
    UNION
    SELECT m.stock_code, s.prev FROM moved m JOIN shown s USING (data_date)
    UNION
    SELECT m.stock_code, t.data_date FROM moved m, trend_day t
    WHERE m.data_date = (SELECT data_date FROM selected)
  )`

const NeedRow = Schema.Struct({
  stock_code: StockCode,
  data_date: Schema.String,
})

// The days `kind` has parsed, and for `period` (`YYYY-MM-DD`, or undefined
// for the newest) the stocks that may have moved on it or on a rail day.
// One batch, so a parse run replacing a day mid-read can't mix two
// versions of it. Its rows are at most the selected day's 21 and the rail's
// 20 days of the moving stocks' blocks and accounts.
export const holderMovesRead = Effect.fnUntraced(function* (
  kind: MoveKind,
  period: string | undefined
) {
  const [dayRows = [], needRows = [], holderRows = [], accountRows = []] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: "SELECT data_date FROM above_5_day ORDER BY data_date",
        params: [],
      },
      {
        sql: `${NEED} SELECT stock_code, data_date FROM need
          ORDER BY stock_code, data_date`,
        params: [period ?? null],
      },
      {
        sql: `${NEED} SELECT h.stock_code, h.data_date, h.no, h.issuer_name,
            h.holder_name, h.holder_key, h.scripless, h.percentage_hundredths
          FROM above_5_holder h JOIN need USING (stock_code, data_date)
          ORDER BY h.stock_code, h.data_date, h.no`,
        params: [period ?? null],
      },
      {
        sql: `${NEED} SELECT a.stock_code, a.data_date, a.no, a.custodian,
            a.account_name, a.origin, a.domicile, a.scripless
          FROM above_5_account a JOIN need USING (stock_code, data_date)
          ORDER BY a.stock_code, a.data_date, a.no, a.ordinal`,
        params: [period ?? null],
      },
    ])
  const periods = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ data_date: Schema.String }))
  )(dayRows).map(({ data_date }) => data_date)
  const holders = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({ ...Above5HolderRow.fields, stock_code: StockCode })
    )
  )(holderRows)
  const accounts = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({ ...Above5AccountRow.fields, stock_code: StockCode })
    )
  )(accountRows)
  const byStock = <R extends { readonly stock_code: StockCode }>(
    rows: ReadonlyArray<R>
  ) =>
    Effect.sync(() => {
      const grouped = new Map<StockCode, Array<R>>()
      for (const row of rows)
        grouped.set(row.stock_code, [
          ...(grouped.get(row.stock_code) ?? []),
          row,
        ])
      return grouped
    })
  const needed = yield* byStock(
    Schema.decodeUnknownSync(Schema.Array(NeedRow))(needRows)
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
  return HolderMovesRead.make({
    kind,
    periods,
    period: periods.includes(period ?? "") ? period : periods.at(-1),
    stocks,
  })
})
