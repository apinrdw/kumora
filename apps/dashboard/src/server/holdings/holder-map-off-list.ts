// A Holder map focus's Off list (spec apinrdw/kumora#733, "Off list"): its
// earlier holdings in neither band now, each at its key's summed last
// stake (`holder-map-holders.ts`).
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { HolderKey } from "@/domain/holdings"
import { placeOf } from "@/lib/holder-map-ids"

import { decodeRows } from "../d1.ts"
import { MAX_ROWS } from "./above-5.ts"
import {
  Above5AccountMapRow,
  Above5MapRow,
  listedHolders,
} from "./holder-map-holders.ts"
import { LeavingRow, leavings } from "./holder-map-moves.ts"
import {
  type Focus,
  type HolderMapLink,
  type HolderMapOffList,
  PERIODS,
} from "./holder-map-schema.ts"

// The most rows of each kind a focus's Off list returns: one day's
// accounts at the above-5% parse's cap (ADR 0045). Stored leavings and a
// custodian's earlier days grow with every period parsed, so each focus
// keeps its newest holders that fit, and says when older ones were left
// out. It cuts between whole groups of rows a holder is summed from, never
// through one, so no holder is summed from part of its rows (ADR 0142).
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const OFF_LIST_ROWS = MAX_ROWS

// Whether the groups newest first, with the rows up to and including each
// (`upto`), were cut: one row.
const cutOf = (groups: string, over: string) =>
  `SELECT EXISTS (SELECT 1 FROM ${groups} WHERE ${over}) AS cut`

// The focus's leavings as of the day and the month: each identity's
// newest leaving, unless it came back since. A stock focus's are its
// identities'. A holder focus's are every identity first listed under its
// key, in any stock, its listings' names matched to the key after. A
// holder's leavings are of one stock, band and period, its key's, so the
// cut keeps whole (stock, band, period)s, newest first, while their
// leavings fit OFF_LIST_ROWS. The key isn't stored on a line (it is its
// name's), so the group is the period's, which holds the key's whole.
const LEFT = (where: string) => `${PERIODS},
  lines AS (
    SELECT stock_code, issuer_name, '5%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_5_move
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT day FROM asof)
    UNION ALL
    SELECT stock_code, issuer_name, '1%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_1_move
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT month FROM band_month)
  ),
  left_lines AS (
    SELECT stock_code, issuer_name, band, name, data_date, stake_before
    FROM lines WHERE nth = 1 AND move = 'off list'
  ),
  left_periods AS (
    SELECT stock_code, band, data_date,
      SUM(COUNT(*)) OVER (
        ORDER BY data_date DESC, stock_code, band ROWS UNBOUNDED PRECEDING
      ) AS upto
    FROM left_lines GROUP BY stock_code, band, data_date
  )`

const leftStatements = (where: string) => [
  `${LEFT(where)} ${cutOf("left_periods", `upto > ${OFF_LIST_ROWS}`)}`,
  `${LEFT(where)}
  SELECT stock_code, issuer_name, band, name, data_date, stake_before
  FROM left_lines JOIN left_periods USING (stock_code, band, data_date)
  WHERE upto <= ${OFF_LIST_ROWS}
  ORDER BY data_date DESC, stock_code, band, name
  LIMIT ${OFF_LIST_ROWS}`,
]

// A custodian's earlier holdings: each above-5% holding with shares in an
// account at one of its spellings of the day (?2) on a day before it, and
// none on the day, by its last such day, the period it left the first
// above-5% day after. Holder moves store no custodian, so this reads the
// accounts through above_5_account_by_custodian. To sum a holding's key on
// its last day (ADR 0142) it reads that day's blocks of the holding and
// every block with the same shares, a repeat's only candidates, with their
// accounts. A holder's rows are one stock-day's, so the cut keeps whole
// stock-days, newest first, while their blocks and their accounts each fit
// OFF_LIST_ROWS. A spelling the custodian no longer uses on the day is
// missed.
const THROUGH = `${PERIODS},
  through AS (
    SELECT DISTINCT data_date, stock_code, no FROM above_5_account
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date < (SELECT day FROM asof) AND scripless > 0
  ),
  through_now AS (
    SELECT DISTINCT holder.stock_code, holder.holder_key
    FROM above_5_account AS account JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    WHERE account.custodian IN (SELECT value FROM json_each(?2))
      AND account.data_date = (SELECT day FROM asof)
      AND account.scripless > 0
  ),
  last_through AS (
    SELECT holder.stock_code, holder.holder_key,
      MAX(holder.data_date) AS last_day
    FROM through JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    WHERE NOT EXISTS (
      SELECT 1 FROM through_now
      WHERE through_now.stock_code = holder.stock_code
        AND through_now.holder_key = holder.holder_key
    )
    GROUP BY holder.stock_code, holder.holder_key
  ),
  -- Materialized, as are the candidates: inlined, SQLite pairs every
  -- block of the custodian's stocks with each block of its day.
  held AS MATERIALIZED (
    SELECT holder.data_date, holder.stock_code, holder.scripless
    FROM last_through JOIN above_5_holder AS holder
      ON holder.data_date = last_through.last_day
        AND holder.stock_code = last_through.stock_code
        AND holder.holder_key = last_through.holder_key
  ),
  -- The holdings' blocks of their last day, and every block of that day
  -- one of them could repeat or be repeated by: a repeat lists the same
  -- shares (lib/daily-holders.ts).
  candidates AS MATERIALIZED (
    SELECT DISTINCT data_date, stock_code, block.no
    FROM held JOIN above_5_holder AS block
      USING (data_date, stock_code, scripless)
  ),
  read_days AS (
    SELECT data_date, stock_code,
      SUM(COUNT(DISTINCT candidates.no)) OVER newest AS blocks_upto,
      SUM(COUNT(account.no)) OVER newest AS accounts_upto
    FROM candidates LEFT JOIN above_5_account AS account
      USING (data_date, stock_code, no)
    GROUP BY data_date, stock_code
    WINDOW newest AS (
      ORDER BY data_date DESC, stock_code ROWS UNBOUNDED PRECEDING
    )
  ),
  kept AS (
    SELECT data_date, stock_code FROM read_days
    WHERE blocks_upto <= ${OFF_LIST_ROWS} AND accounts_upto <= ${OFF_LIST_ROWS}
  )`

// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
export const OFF_LIST: Record<Focus["kind"], ReadonlyArray<string>> = {
  stock: leftStatements("stock_code = ?2"),
  // An identity is `<key>#<n>`: those of the key sort from `<key>#` up to,
  // not including, `<key>$`.
  holder: leftStatements("holder >= ?2 || '#' AND holder < ?2 || '$'"),
  custodian: [
    `${THROUGH} ${cutOf(
      "read_days",
      `blocks_upto > ${OFF_LIST_ROWS} OR accounts_upto > ${OFF_LIST_ROWS}`
    )}`,
    `${THROUGH}
  SELECT last_through.stock_code, holder_key, last_day,
    (SELECT MIN(data_date) FROM above_5_day
      WHERE data_date > last_through.last_day) AS left_on
  FROM last_through JOIN kept
    ON kept.data_date = last_through.last_day
      AND kept.stock_code = last_through.stock_code
  ORDER BY last_day DESC, last_through.stock_code, holder_key
  LIMIT ${OFF_LIST_ROWS}`,
    `${THROUGH}
  SELECT stock_code, data_date, no, issuer_name, holder_name, holder_key,
    scripless, percentage_hundredths
  FROM candidates JOIN kept USING (data_date, stock_code)
    JOIN above_5_holder USING (data_date, stock_code, no)
  ORDER BY stock_code, data_date, no
  LIMIT ${OFF_LIST_ROWS}`,
    `${THROUGH}
  SELECT stock_code, data_date, no, custodian, account_name, origin,
    domicile, scripless
  FROM candidates JOIN kept USING (data_date, stock_code)
    JOIN above_5_account USING (data_date, stock_code, no)
  ORDER BY stock_code, data_date, no, ordinal
  LIMIT ${OFF_LIST_ROWS}`,
  ],
}

const CutRow = Schema.Struct({ cut: Schema.Number })

const OffListRow = Schema.Struct({
  ...LeavingRow.fields,
  issuer_name: Schema.String,
})

const ThroughRow = Schema.Struct({
  stock_code: StockCode,
  holder_key: Schema.String,
  last_day: WibDate,
  left_on: WibDate,
})

// An Off list as read: its leavings by place, the issuers they name, and
// whether older ones were left out.
interface OffListRead {
  readonly leavings: ReadonlyMap<string, HolderMapOffList>
  readonly issuers: ReadonlyArray<readonly [StockCode, string]>
  readonly cut: boolean
}

// A stock or holder focus's leavings, whole periods that fit.
const linesRead = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Record<string, unknown>>,
  cut: boolean
) {
  const read = yield* decodeRows(OffListRow)(rows)
  return {
    leavings: yield* leavings(read),
    issuers: read.map((row) => [row.stock_code, row.issuer_name] as const),
    cut,
  } satisfies OffListRead
})

// The blocks and accounts of a custodian's holdings' last days, by
// `<code> <day>`, in report order.
const blocksByDay = Effect.fnUntraced(function* (
  blockRows: ReadonlyArray<Record<string, unknown>>,
  accountRows: ReadonlyArray<Record<string, unknown>>
) {
  const days = new Map<
    string,
    {
      holders: Array<typeof Above5MapRow.Type>
      accounts: Array<typeof Above5AccountMapRow.Type>
    }
  >()
  const dayOf = (code: StockCode, day: string) => {
    const id = `${code} ${day}`
    const known = days.get(id) ?? { holders: [], accounts: [] }
    days.set(id, known)
    return known
  }
  for (const row of yield* decodeRows(Above5MapRow)(blockRows))
    dayOf(row.stock_code, row.data_date).holders.push(row)
  for (const row of yield* decodeRows(Above5AccountMapRow)(accountRows))
    dayOf(row.stock_code, row.data_date).accounts.push(row)
  return days
})

// Each of those stock-days' issuer and holders, by key.
const lastDays = Effect.fnUntraced(function* (
  blockRows: ReadonlyArray<Record<string, unknown>>,
  accountRows: ReadonlyArray<Record<string, unknown>>
) {
  const days = new Map<
    string,
    {
      issuer: string
      holders: Map<HolderKey, { name: string; hundredths: number }>
    }
  >()
  for (const [id, { holders, accounts }] of yield* blocksByDay(
    blockRows,
    accountRows
  )) {
    const [first] = holders
    if (first === undefined) continue
    const listed = yield* listedHolders(
      first.stock_code,
      WibDate.make(first.data_date),
      holders,
      accounts
    )
    days.set(id, {
      issuer: first.issuer_name,
      holders: new Map(listed.map(({ key, sum }) => [key, sum])),
    })
  }
  return days
})

// A custodian focus's leavings: each holding through it before, at its
// key's summed stake of its last day through it, whole days that fit.
const throughRead = Effect.fnUntraced(function* (
  holdingRows: ReadonlyArray<Record<string, unknown>>,
  blockRows: ReadonlyArray<Record<string, unknown>>,
  accountRows: ReadonlyArray<Record<string, unknown>>,
  cut: boolean
) {
  const read = yield* decodeRows(ThroughRow)(holdingRows)
  const days = yield* lastDays(blockRows, accountRows)
  const out = new Map<string, HolderMapOffList>()
  const issuers: Array<readonly [StockCode, string]> = []
  for (const holding of read) {
    const key = HolderKey.make(holding.holder_key)
    const day = days.get(`${holding.stock_code} ${holding.last_day}`)
    // None when its every block repeats another key's: that key holds it.
    const held = day?.holders.get(key)
    if (day === undefined || held === undefined) continue
    issuers.push([holding.stock_code, day.issuer])
    out.set(yield* placeOf(holding.stock_code, key), {
      code: holding.stock_code,
      band: "5%",
      holder: key,
      name: held.name,
      since: holding.left_on,
      percentageHundredths: held.hundredths,
    })
  }
  return { leavings: out, issuers, cut } satisfies OffListRead
})

// The focus's Off list statements' rows, read: whether it was cut, then
// its rows.
export const offListRead = Effect.fnUntraced(function* (
  focus: Focus,
  [cutRows = [], first = [], blocks = [], accounts = []]: ReadonlyArray<
    ReadonlyArray<Record<string, unknown>>
  >
) {
  const [flag] = yield* decodeRows(CutRow)(cutRows)
  const cut = flag?.cut === 1
  return focus.kind === "custodian"
    ? yield* throughRead(first, blocks, accounts, cut)
    : yield* linesRead(first, cut)
})

// The focus's Off list: its leavings in neither band now. A holding in
// either band now is no earlier one: a holder that left the above-5% list
// for the 1% band crossed down out of 5%. A custodian's are holdings no
// longer through it, whether they left the list or moved their account.
export const offListOf = Effect.fnUntraced(function* (
  focus: Focus,
  first: ReadonlyArray<HolderMapLink>,
  left: ReadonlyMap<string, HolderMapOffList>
) {
  const linked = new Set<string>()
  for (const { code, holder } of first) linked.add(yield* placeOf(code, holder))
  const offList: Array<HolderMapOffList> = []
  for (const [place, holding] of left)
    if (
      !linked.has(place) &&
      (focus.kind !== "holder" || holding.holder === focus.key)
    )
      offList.push(holding)
  return offList
})
