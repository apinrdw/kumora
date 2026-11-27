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
  type Budgeted,
  drawable,
  DRAWABLE_LINE,
  type Focus,
  type HolderMapLink,
  type HolderMapOffList,
  identityKey,
  PERIODS,
  storedRows,
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
const LEFT = ({ where, by }: LeftFocus) => `${PERIODS},
  lines AS (
    SELECT stock_code, issuer_name, '5%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_5_move INDEXED BY above_5_move_by_${by}
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT day FROM asof) AND ${DRAWABLE_LINE}
    UNION ALL
    SELECT stock_code, issuer_name, '1%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_1_move INDEXED BY above_1_move_by_${by}
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT month FROM band_month) AND ${DRAWABLE_LINE}
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

// A stock or holder focus's lines (`where`), read through the index by
// its stock or its holder: the planner, with no statistics, may otherwise
// scan every stored line by day.
interface LeftFocus {
  readonly where: string
  readonly by: "stock" | "holder"
}

const leftStatements = (focus: LeftFocus): ReadonlyArray<Budgeted> => [
  {
    sql: `${LEFT(focus)} ${cutOf("left_periods", `upto > ${OFF_LIST_ROWS}`)}`,
    rows: 1,
  },
  {
    sql: `${LEFT(focus)}
  SELECT stock_code, issuer_name, band, name, data_date, stake_before
  FROM left_lines JOIN left_periods USING (stock_code, band, data_date)
  WHERE upto <= ${OFF_LIST_ROWS}
  ORDER BY data_date DESC, stock_code, band, name
  LIMIT ${OFF_LIST_ROWS}`,
    rows: OFF_LIST_ROWS,
  },
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
  through AS MATERIALIZED (
    SELECT DISTINCT data_date, stock_code, no
    FROM above_5_account INDEXED BY above_5_account_by_custodian
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date < (SELECT day FROM asof) AND scripless > 0
      AND ${drawable({ code: "stock_code" })}
  ),
  through_now AS MATERIALIZED (
    SELECT DISTINCT holder.stock_code, holder.holder_key
    FROM above_5_account AS account JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    WHERE account.custodian IN (SELECT value FROM json_each(?2))
      AND account.data_date = (SELECT day FROM asof)
      AND account.scripless > 0
      AND ${drawable({ code: "holder.stock_code", key: "holder.holder_key" })}
  ),
  through_keys AS MATERIALIZED (
    SELECT holder.stock_code, holder.holder_key,
      MAX(holder.data_date) AS last_day
    FROM through JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    WHERE ${drawable({ code: "holder.stock_code", key: "holder.holder_key" })}
    GROUP BY holder.stock_code, holder.holder_key
  ),
  -- Every CTE is materialized, each stock-day's blocks are walked once
  -- (CROSS JOIN keeps last_days outside), and every other match is a row
  -- value IN an uncorrelated subquery, which SQLite reads once into an
  -- index (a NOT IN it may scan, so the one exclusion is an EXCEPT): no
  -- step pairs a row with each row of another. A join or a correlated
  -- EXISTS is planned case by case, and SQLite paired 240k ×
  -- 8,000 blocks (codex review of apinrdw/kumora#741, round 4), 8,000
  -- former holdings of one stock-day at the same shares 64 million, and
  -- 240k holdings with each of the 8,000 still held (round 9).
  last_through AS MATERIALIZED (
    SELECT stock_code, holder_key, last_day FROM through_keys
    WHERE (stock_code, holder_key) IN (
      SELECT stock_code, holder_key FROM through_keys
      EXCEPT SELECT stock_code, holder_key FROM through_now
    )
  ),
  last_days AS MATERIALIZED (
    SELECT DISTINCT last_day AS data_date, stock_code FROM last_through
  ),
  -- The shares of the holdings' blocks of their last day, once each.
  held AS MATERIALIZED (
    SELECT DISTINCT block.data_date, block.stock_code, block.scripless
    FROM last_days CROSS JOIN above_5_holder AS block
      ON block.data_date = last_days.data_date
        AND block.stock_code = last_days.stock_code
    WHERE (block.stock_code, block.holder_key, block.data_date) IN (
      SELECT stock_code, holder_key, last_day FROM last_through
    )
      AND ${drawable({ code: "block.stock_code", key: "block.holder_key" })}
  ),
  -- Every block of those days one of them could repeat or be repeated
  -- by: a repeat lists the same shares (lib/daily-holders.ts). Each once.
  candidates AS MATERIALIZED (
    SELECT block.data_date, block.stock_code, block.no
    FROM last_days CROSS JOIN above_5_holder AS block
      ON block.data_date = last_days.data_date
        AND block.stock_code = last_days.stock_code
    WHERE (block.data_date, block.stock_code, block.scripless) IN (
      SELECT data_date, stock_code, scripless FROM held
    )
      AND ${drawable({ code: "block.stock_code", key: "block.holder_key" })}
  ),
  read_days AS MATERIALIZED (
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
  kept AS MATERIALIZED (
    SELECT data_date, stock_code FROM read_days
    WHERE blocks_upto <= ${OFF_LIST_ROWS} AND accounts_upto <= ${OFF_LIST_ROWS}
  )`

// Whether a custodian's holding of `alias`, or its block, is of a kept
// stock-day.
const isKept = (alias: string, day: string) =>
  `(${alias}.${day}, ${alias}.stock_code) IN (
    SELECT data_date, stock_code FROM kept
  )`

// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
export const OFF_LIST: Record<Focus["kind"], ReadonlyArray<Budgeted>> = {
  stock: leftStatements({ where: "stock_code = ?2", by: "stock" }),
  // An identity is `<key>#<n>`: those of the key sort from `<key>#` up to,
  // not including, `<key>$`, the range the index reads, and of them, those
  // whose key is the key, not one that starts with it and a `#`.
  holder: leftStatements({
    where: `holder >= ?2 || '#' AND holder < ?2 || '$'
      AND ${identityKey("holder")} = ?2`,
    by: "holder",
  }),
  custodian: [
    {
      sql: `${THROUGH} ${cutOf(
        "read_days",
        `blocks_upto > ${OFF_LIST_ROWS} OR accounts_upto > ${OFF_LIST_ROWS}`
      )}`,
      rows: 1,
    },
    {
      sql: `${THROUGH}
  SELECT last_through.stock_code, holder_key, last_day,
    (SELECT MIN(data_date) FROM above_5_day
      WHERE data_date > last_through.last_day) AS left_on
  FROM last_through
  WHERE ${isKept("last_through", "last_day")}
  ORDER BY last_day DESC, last_through.stock_code, holder_key
  LIMIT ${OFF_LIST_ROWS}`,
      rows: OFF_LIST_ROWS,
    },
    {
      sql: `${THROUGH}
  SELECT stock_code, data_date, no, issuer_name, holder_name, holder_key,
    scripless, percentage_hundredths
  FROM candidates JOIN above_5_holder USING (data_date, stock_code, no)
  WHERE ${isKept("candidates", "data_date")}
  ORDER BY stock_code, data_date, no
  LIMIT ${OFF_LIST_ROWS}`,
      rows: OFF_LIST_ROWS,
    },
    {
      sql: `${THROUGH}
  SELECT stock_code, data_date, no, custodian, account_name, origin,
    domicile, scripless
  FROM candidates JOIN above_5_account USING (data_date, stock_code, no)
  WHERE ${isKept("candidates", "data_date")}
  ORDER BY stock_code, data_date, no, ordinal
  LIMIT ${OFF_LIST_ROWS}`,
      rows: OFF_LIST_ROWS,
    },
  ],
}

const CutRow = Schema.Struct({ cut: Schema.Number })

const OffListRow = Schema.Struct({
  ...LeavingRow.fields,
  issuer_name: Schema.String,
})

const ThroughRow = Schema.Struct({
  stock_code: StockCode,
  holder_key: HolderKey,
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
  const read = yield* storedRows(OffListRow)(rows)
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
  for (const row of yield* storedRows(Above5MapRow)(blockRows))
    dayOf(row.stock_code, row.data_date).holders.push(row)
  for (const row of yield* storedRows(Above5AccountMapRow)(accountRows))
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
  const read = yield* storedRows(ThroughRow)(holdingRows)
  const days = yield* lastDays(blockRows, accountRows)
  const out = new Map<string, HolderMapOffList>()
  const issuers: Array<readonly [StockCode, string]> = []
  for (const holding of read) {
    const key = holding.holder_key
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
