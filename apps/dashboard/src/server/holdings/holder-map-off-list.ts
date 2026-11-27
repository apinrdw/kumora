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
  keyPeriodId,
  leavingAt,
  listedHolders,
} from "./holder-map-holders.ts"
import { LeavingRow, leavings } from "./holder-map-moves.ts"
import {
  type Focus,
  type HolderMapLink,
  type HolderMapOffList,
  PERIODS,
} from "./holder-map-schema.ts"

// The most leavings a focus's Off list reads, newest first: one day's
// accounts at the above-5% parse's cap (ADR 0045). Stored leavings grow
// with every period parsed, so each focus reads one more than this, to
// tell the side panel older ones were left out.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const OFF_LIST_ROWS = MAX_ROWS

// The focus's leavings as of the day and the month: each identity's
// newest leaving, unless it came back since, the newest OFF_LIST_ROWS and
// one more. A stock focus's are its identities'. A holder focus's are
// every identity first listed under its key, in any stock, its listings'
// names matched to the key after.
const OFF_LIST_LINES = (where: string) => `SELECT stock_code, issuer_name,
    band, name, data_date, stake_before FROM (
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
  )
  WHERE nth = 1 AND move = 'off list'
  ORDER BY data_date DESC, stock_code, name
  LIMIT ${OFF_LIST_ROWS + 1}`

// A custodian's earlier holdings: each above-5% holding with shares in an
// account at one of its spellings of the day (?2) on a day before it, by
// its last such day, the period it left the first above-5% day after. A
// holding still there is dropped after (`offListOf`). Holder moves store
// no custodian, so this reads the accounts through
// above_5_account_by_custodian, every earlier day's at the custodian, and
// keeps the OFF_LIST_ROWS newest holdings and one more. A spelling the
// custodian no longer uses on the day is missed.
const THROUGH = `${PERIODS},
  through AS (
    SELECT DISTINCT data_date, stock_code, no FROM above_5_account
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date < (SELECT day FROM asof) AND scripless > 0
  ),
  last_through AS (
    SELECT holder.stock_code, holder.holder_key,
      MAX(holder.data_date) AS last_day
    FROM through JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    GROUP BY holder.stock_code, holder.holder_key
    ORDER BY last_day DESC, holder.stock_code, holder.holder_key
    LIMIT ${OFF_LIST_ROWS + 1}
  ),
  held AS (
    SELECT holder.data_date, holder.stock_code, holder.scripless
    FROM last_through JOIN above_5_holder AS holder
      ON holder.data_date = last_through.last_day
        AND holder.stock_code = last_through.stock_code
        AND holder.holder_key = last_through.holder_key
  ),
  -- The holdings' blocks of their last day, and every block of that day
  -- one of them could repeat or be repeated by: a repeat lists the same
  -- shares (lib/daily-holders.ts).
  candidates AS (
    SELECT DISTINCT data_date, stock_code, block.no
    FROM held JOIN above_5_holder AS block
      USING (data_date, stock_code, scripless)
  )`

// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
export const OFF_LIST: Record<Focus["kind"], ReadonlyArray<string>> = {
  stock: [`${PERIODS} ${OFF_LIST_LINES("stock_code = ?2")}`],
  // An identity is `<key>#<n>`: those of the key sort from `<key>#` up to,
  // not including, `<key>$`.
  holder: [
    `${PERIODS} ${OFF_LIST_LINES("holder >= ?2 || '#' AND holder < ?2 || '$'")}`,
  ],
  custodian: [
    `${THROUGH}
  SELECT stock_code, holder_key, last_day,
    (SELECT MIN(data_date) FROM above_5_day
      WHERE data_date > last_through.last_day) AS left_on
  FROM last_through
  ORDER BY last_day DESC, stock_code, holder_key`,
    `${THROUGH}
  SELECT stock_code, data_date, no, issuer_name, holder_name, holder_key,
    scripless, percentage_hundredths
  FROM candidates JOIN above_5_holder USING (data_date, stock_code, no)
  ORDER BY stock_code, data_date, no`,
    `${THROUGH}
  SELECT stock_code, data_date, no, custodian, account_name, origin,
    domicile, scripless
  FROM candidates JOIN above_5_account USING (data_date, stock_code, no)
  ORDER BY stock_code, data_date, no, ordinal`,
  ],
}

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

// A stock or holder focus's leavings, the newest OFF_LIST_ROWS lines. One
// more read tells they were cut, and the lines of its holder and period
// are left out too, so no holder is summed from some of its lines.
const linesRead = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Record<string, unknown>>
) {
  const read = yield* decodeRows(OffListRow)(rows)
  const over = read[OFF_LIST_ROWS]
  let kept = read.slice(0, OFF_LIST_ROWS)
  if (over !== undefined) {
    const cutAt = yield* keyPeriodId(yield* leavingAt(over))
    const whole: Array<typeof OffListRow.Type> = []
    for (const row of kept)
      if ((yield* keyPeriodId(yield* leavingAt(row))) !== cutAt) whole.push(row)
    kept = whole
  }
  return {
    leavings: yield* leavings(kept),
    issuers: kept.map((row) => [row.stock_code, row.issuer_name] as const),
    cut: over !== undefined,
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
// key's summed stake of its last day through it.
const throughRead = Effect.fnUntraced(function* (
  holdingRows: ReadonlyArray<Record<string, unknown>>,
  blockRows: ReadonlyArray<Record<string, unknown>>,
  accountRows: ReadonlyArray<Record<string, unknown>>
) {
  const read = yield* decodeRows(ThroughRow)(holdingRows)
  const days = yield* lastDays(blockRows, accountRows)
  const cut = read.length > OFF_LIST_ROWS
  const out = new Map<string, HolderMapOffList>()
  const issuers: Array<readonly [StockCode, string]> = []
  for (const holding of read.slice(0, OFF_LIST_ROWS)) {
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

// The focus's Off list statements' rows, read.
export const offListRead = (
  focus: Focus,
  [first = [], blocks = [], accounts = []]: ReadonlyArray<
    ReadonlyArray<Record<string, unknown>>
  >
) =>
  focus.kind === "custodian"
    ? throughRead(first, blocks, accounts)
    : linesRead(first)

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
