// Holder moves' Daily lines, derived from the parsed above-5% days
// (holdings-migrations/0011_above_5_move.sql) by derived-moves.ts: the
// above-5% parse run, after parsing its days, derives each day whose basis
// changed, so the Holder moves page reads one day's lines (holder-moves.ts).
// A day's lines are each moving stock's Daily holders movers on it
// (lib/daily-holders.ts), the same view model the stock page runs, from the
// stock's days the page reads up to it (holders-window.ts). Spec
// apinrdw/kumora#673, "Holder moves".
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, type WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  type DailyHolderLine,
  dailyHolders,
  movedCustodians,
  transferredCustodians,
} from "@/lib/daily-holders"

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
import { DAILY_WINDOW } from "./holders-window.ts"
import {
  Above5SecuritiesAccountRow,
  above5Days,
  Above5HolderRow,
} from "./stock-page.ts"

// The stocks whose holders may have moved on ?1 against ?2. A stock-day's
// marks are its blocks (by place, key and shares) and their securities
// accounts (custodian, name and shares): when none differ from the day
// before's, the day's holders, collapsed and matched, are the day before's,
// each unchanged.
const MOVED = `
  block AS (
    SELECT data_date, stock_code, no, holder_key, scripless,
      ROW_NUMBER() OVER (
        PARTITION BY data_date, stock_code ORDER BY no
      ) AS place
    FROM above_5_holder
    WHERE data_date IN (?1, ?2)
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
    WHERE data_date = ?1
  ),
  prev_mark AS (
    SELECT stock_code, place, a, b, scripless, n FROM mark
    WHERE data_date = ?2
  ),
  moved AS (
    SELECT stock_code
    FROM (SELECT * FROM now_mark EXCEPT SELECT * FROM prev_mark)
    UNION
    SELECT stock_code
    FROM (SELECT * FROM prev_mark EXCEPT SELECT * FROM now_mark)
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
  ...Above5SecuritiesAccountRow.fields,
  stock_code: StockCode,
})

// The rows of `stocks`' blocks and securities accounts, each from its since
// through `day`, by stock, as read.
const readStocks = Effect.fnUntraced(function* (
  stocks: ReadonlyArray<MovedStock>,
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
type StockRows = Effect.Success<ReturnType<typeof readStocks>>

// A Daily holders line of the day, when it moved: listed with a move other
// than Unchanged, or on the day's Off list.
const moveLine = Effect.fnUntraced(function* (line: DailyHolderLine) {
  const { move } = line
  if (move === undefined || move === "unchanged") return undefined
  return {
    holder: line.holder,
    name: line.name,
    aliases: line.aliases,
    renamedFrom: line.renamedFrom,
    move,
    custodians: yield* movedCustodians(line.accounts),
    shareChange: line.shareChange,
    stake: line.stake,
    percentageChange: line.percentageChange,
    transfer:
      move === "transfer"
        ? yield* transferredCustodians(line.accounts)
        : undefined,
    trend: line.trend,
  } satisfies StockMoveLine
})

// The stock's Daily holders movers on `day`, from its rows of `read`.
const dailyLines = Effect.fnUntraced(function* (
  rows: StockRows,
  code: StockCode,
  read: ReadonlyArray<WibDate>,
  day: WibDate
) {
  const blocks = yield* decodeRows(HolderOfStock)(rows.holders.get(code) ?? [])
  const held = yield* dailyHolders(
    yield* above5Days(
      read.map((data_date) => ({ data_date, listed_shares: null })),
      blocks,
      yield* decodeRows(AccountOfStock)(rows.accounts.get(code) ?? [])
    ),
    day
  )
  const lines: Array<StockMoveLine> = []
  if (held?.dataDate === day)
    for (const line of [...held.listed, ...held.offList]) {
      const moved = yield* moveLine(line)
      if (moved !== undefined) lines.push(moved)
    }
  return { issuerName: blocks.at(-1)?.issuer_name ?? "", lines }
})

const DAILY: MovesSource<StockRows> = {
  // Bumped whenever deriving changes what it stores: the run then derives
  // every day again.
  // 2: a holder move may be a Transfer.
  //
  // Decision: a Transfer is shares crossing brokers with the total unchanged
  // (apps/dashboard/docs/adr/0135-a-transfer-is-shares-crossing-brokers-with-the-total-unchanged.md)
  version: 2,
  window: DAILY_WINDOW,
  lines: "above_5_move",
  derived: "above_5_move_day",
  moved: MOVED,
  read: readStocks,
  linesOf: dailyLines,
}

// The parsed days whose lines are missing or derived from another basis,
// oldest first.
export const staleMoveDays = () => stalePeriods(DAILY)

// Replaces `day`'s lines with those derived from its parsed days now; the
// number of lines.
export const deriveMoveDay = (day: WibDate) => derivePeriod(DAILY, day)
