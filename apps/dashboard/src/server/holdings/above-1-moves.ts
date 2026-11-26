// Holder moves' Monthly lines, derived from the parsed above-1% months
// (holdings-migrations/0012_above_1_move.sql) by derived-moves.ts: the
// above-1% parse run, after parsing its months, derives each month whose
// basis changed, so the Holder moves page reads one month's lines
// (holder-moves.ts). A month's lines are each moving stock's Major holders
// chips that moved in it (lib/major-holders.ts), the same view model the
// stock page runs, from the stock's months the page reads up to it
// (holders-window.ts). Spec apinrdw/kumora#673, "Holder moves";
// apinrdw/kumora#680.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, type WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { type HolderLine, majorHoldersOn } from "@/lib/major-holders"

import { decodeRows } from "../d1.ts"
import { HoldingsDb } from "./db.ts"
import {
  byStock,
  derivePeriod,
  type MovedStock,
  type MovesSource,
  stalePeriods,
  type StockMoveLine,
  WANT,
} from "./derived-moves.ts"
import { MONTHLY_WINDOW } from "./holders-window.ts"
import { above1Months, Above1HoldingRow } from "./stock-page.ts"

// The stocks whose holders may have moved in ?1 against ?2. A stock-month
// is marked by its holders by holder key and summed %, Major holders'
// change rule. It may have moved only with rows in both months: otherwise
// each is unchanged, or the month before is a gap.
const MOVED = `
  mark AS (
    SELECT data_date, stock_code, holder_key,
      SUM(percentage_hundredths) AS hundredths
    FROM above_1_holding
    WHERE data_date IN (?1, ?2)
    GROUP BY data_date, stock_code, holder_key
  ),
  now_mark AS (
    SELECT stock_code, holder_key, hundredths FROM mark WHERE data_date = ?1
  ),
  prev_mark AS (
    SELECT stock_code, holder_key, hundredths FROM mark WHERE data_date = ?2
  ),
  moved AS (
    SELECT stock_code
    FROM (SELECT * FROM now_mark EXCEPT SELECT * FROM prev_mark)
    UNION
    SELECT stock_code
    FROM (SELECT * FROM prev_mark EXCEPT SELECT * FROM now_mark)
    INTERSECT SELECT stock_code FROM now_mark
    INTERSECT SELECT stock_code FROM prev_mark
  )`

// Only what a moved line reads (moveLine): a holder's key, name, shares
// and %, its row's labels left out, and the issuer's name only in the
// month, where the stock has rows. A read's rows set its heap.
const HOLDINGS = `${WANT}
  SELECT h.stock_code, h.data_date,
    CASE WHEN h.data_date = ?2 THEN h.issuer_name ELSE '' END
      AS issuer_name,
    h.holder_key, h.investor_name, NULL AS classification,
    NULL AS investor_type, NULL AS origin, NULL AS domicile,
    NULL AS controller, h.scripless, h.scrip, h.total,
    h.percentage_hundredths
  FROM above_1_holding h JOIN want w ON h.stock_code = w.stock_code
  WHERE h.data_date >= w.since AND h.data_date <= ?2
  ORDER BY h.stock_code, h.data_date, h.seq`

const HoldingOfStock = Schema.Struct({
  ...Above1HoldingRow.fields,
  stock_code: StockCode,
  issuer_name: Schema.String,
})

// The rows of `stocks`' holdings, each from its since through `month`, by
// stock, as read.
const readStocks = Effect.fnUntraced(function* (
  stocks: ReadonlyArray<MovedStock>,
  month: WibDate
) {
  const want = JSON.stringify(
    stocks.map(({ stock_code, since }) => [stock_code, since])
  )
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    { sql: HOLDINGS, params: [want, month] },
  ])
  return yield* byStock(rows)
})
type StockRows = Effect.Success<ReturnType<typeof readStocks>>

// A Major holders line of the month, when it moved: no aliases, rename or
// Through, and the stake under 1% on the side it isn't listed. A New
// holder's whole holding came in, an Off-list one's last went out.
const moveLine = (line: HolderLine) =>
  Effect.sync((): StockMoveLine | undefined => {
    const { change } = line
    if (change === undefined || change === "unchanged") return undefined
    return {
      holder: line.holder,
      name: line.name,
      aliases: [],
      renamedFrom: undefined,
      move: change,
      custodians: [],
      shareChange:
        change === "new"
          ? line.total
          : change === "off list"
            ? -line.total
            : line.shareChange,
      stake:
        change === "off list"
          ? { before: line.percentageHundredths }
          : {
              ...(line.percentageChange !== undefined && {
                before: line.percentageHundredths - line.percentageChange,
              }),
              now: line.percentageHundredths,
            },
      percentageChange: line.percentageChange,
      transfer: undefined,
      trend: line.trend,
    }
  })

// The stock's Major holders chips that moved in `month`, from its rows of
// `read`.
const monthlyLines = Effect.fnUntraced(function* (
  rows: StockRows,
  code: StockCode,
  read: ReadonlyArray<WibDate>,
  month: WibDate
) {
  const holdings = yield* decodeRows(HoldingOfStock)(rows.get(code) ?? [])
  const held = yield* majorHoldersOn(
    yield* above1Months(
      read.map((data_date) => ({ data_date })),
      holdings
    ),
    month
  )
  const lines: Array<StockMoveLine> = []
  if (held?.dataDate === month)
    for (const line of [...held.listed, ...held.offList]) {
      const moved = yield* moveLine(line)
      if (moved !== undefined) lines.push(moved)
    }
  return { issuerName: holdings.at(-1)?.issuer_name ?? "", lines }
})

const MONTHLY: MovesSource<StockRows> = {
  // Bumped whenever deriving changes what it stores: the run then derives
  // every month again.
  version: 1,
  window: MONTHLY_WINDOW,
  lines: "above_1_move",
  derived: "above_1_move_month",
  moved: MOVED,
  read: readStocks,
  linesOf: monthlyLines,
}

// The parsed months whose lines are missing or derived from another basis,
// oldest first.
export const staleMoveMonths = () => stalePeriods(MONTHLY)

// Replaces `month`'s lines with those derived from its parsed months now;
// the number of lines.
export const deriveMoveMonth = (month: WibDate) => derivePeriod(MONTHLY, month)
