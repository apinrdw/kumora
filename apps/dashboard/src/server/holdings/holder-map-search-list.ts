// What the Holder map's search offers (spec apinrdw/kumora#733, story 2):
// the stocks, holders and custodians it can focus.
import { type BrokerCode, StockCode, type WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { type CustodianId, HolderKey } from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"
import {
  custodianNames,
  custodianOf,
  DAY_SPELLINGS_SQL,
  SpellingRow,
} from "./holder-map-custodians.ts"
import {
  type Budgeted,
  DAY_ROWS,
  MONTH_ROWS,
  PERIODS,
} from "./holder-map-schema.ts"

// A custodian as the search lists it.
interface HolderMapCustodian {
  readonly id: CustodianId
  readonly broker: BrokerCode | undefined
  readonly name: string
}

const SearchStockRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
})

const SearchHolderRow = Schema.Struct({
  holder_key: HolderKey,
  name: Schema.String,
})

const DAY = "(SELECT day FROM asof)"
const MONTH = "(SELECT month FROM band_month)"

// The stocks of the day and the month, by code: at most a stock per row.
const STOCKS_SQL = {
  sql: `${PERIODS} SELECT stock_code, MAX(issuer_name) AS issuer_name FROM (
    SELECT stock_code, issuer_name FROM above_5_holder
    WHERE data_date = ${DAY}
    UNION ALL
    SELECT stock_code, issuer_name FROM above_1_holding
    WHERE data_date = ${MONTH}
  )
  GROUP BY stock_code ORDER BY stock_code`,
  rows: DAY_ROWS + MONTH_ROWS,
} satisfies Budgeted

// One holder per key across the two reports: at most a key per row.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const HOLDERS_SQL = {
  sql: `${PERIODS} SELECT holder_key, MAX(name) AS name FROM (
    SELECT holder_key, holder_name AS name FROM above_5_holder
    WHERE data_date = ${DAY}
    UNION ALL
    SELECT holder_key, investor_name AS name FROM above_1_holding
    WHERE data_date = ${MONTH}
  )
  GROUP BY holder_key ORDER BY name`,
  rows: DAY_ROWS + MONTH_ROWS,
} satisfies Budgeted

// The stocks and holders the map's day or its 1% band's month lists, as the
// map in view is drawn (`PERIODS`: `day` or the newest, none for a day
// with no above-5% report), stocks by code, holders by key with a name of
// theirs, a code that isn't a stock code's shape left out, and the
// custodians of that day's securities accounts, one each. The stock page's list comes
// from the classification, KSEI and investor-type reports, which can miss a
// stock with holders. At most one day's and one month's rows, each within
// its parse cap (ADR 0045).
export const holderMapSearchList = Effect.fnUntraced(function* (
  day: WibDate | undefined
) {
  const params = [day ?? null]
  const [stockRows = [], holderRows = [], spellingRows = []] =
    yield* (yield* HoldingsDb).batch([
      { ...STOCKS_SQL, params },
      { ...HOLDERS_SQL, params },
      { ...DAY_SPELLINGS_SQL, params },
    ])
  const isStock = Schema.is(SearchStockRow)
  const isHolder = Schema.is(SearchHolderRow)
  const isSpelling = Schema.is(SpellingRow)
  const spellings = spellingRows.flatMap((row) =>
    isSpelling(row) ? [row.custodian] : []
  )
  const names = yield* custodianNames(spellings)
  const custodians = new Map<CustodianId, HolderMapCustodian>()
  for (const spelling of spellings) {
    const { id, broker } = yield* custodianOf(spelling)
    custodians.set(id, { id, broker, name: names.get(id) ?? spelling })
  }
  return {
    custodians: [...custodians.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    stocks: stockRows.flatMap((row) =>
      isStock(row)
        ? [{ code: row.stock_code, issuerName: row.issuer_name }]
        : []
    ),
    holders: holderRows.flatMap((row) =>
      isHolder(row) ? [{ key: row.holder_key, name: row.name }] : []
    ),
  }
})
