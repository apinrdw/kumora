// What the Holder map's search offers (spec apinrdw/kumora#733, story 2):
// the stocks, holders and custodians it can focus.
import { type BrokerCode, StockCode, type WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import type { CustodianId, HolderKey } from "@/domain/holdings"

import { decodeRows } from "../d1.ts"
import { HoldingsDb } from "./db.ts"
import {
  custodianNames,
  custodianOf,
  DAY_SPELLINGS_SQL,
  SpellingRow,
} from "./holder-map-custodians.ts"
import {
  Above1MapRow,
  Above5AccountMapRow,
  Above5MapRow,
} from "./holder-map-holders.ts"
import {
  type Budgeted,
  DAY_ROWS,
  MONTH_ROWS,
  PERIODS,
  PERIODS_SQL,
  PeriodsRow,
} from "./holder-map-schema.ts"
import { byStock, linkRows, stockLinks } from "./holder-map.ts"

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

const DAY = "(SELECT day FROM asof)"
const MONTH = "(SELECT month FROM band_month)"

// The stocks of the day and the month, by code: at most a stock per row.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
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

// The holders of every stock, one each by key, with the greatest name of
// its links, by name: the keys the map links (`stockLinks`), so none of a
// repeat block the map folds into another key's (ADR 0131).
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const holdersOf = Effect.fnUntraced(function* ([
  periodRow = [],
  holderRows = [],
  accountRows = [],
  monthRows = [],
]: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) {
  const [periods] = yield* decodeRows(PeriodsRow)(periodRow)
  const stocks = yield* byStock({
    holders: yield* decodeRows(Above5MapRow)(holderRows),
    accounts: yield* decodeRows(Above5AccountMapRow)(accountRows),
    month: yield* decodeRows(Above1MapRow)(monthRows),
    holdersBefore: [],
    accountsBefore: [],
  })
  const names = new Map<HolderKey, string>()
  for (const [code, rows] of stocks) {
    const { links } = yield* stockLinks(
      code,
      periods?.day ?? undefined,
      periods?.month ?? undefined,
      rows
    )
    for (const { holder, name } of links) {
      const known = names.get(holder)
      if (known === undefined || name > known) names.set(holder, name)
    }
  }
  return [...names]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
})

// The stocks and holders the map's day or its 1% band's month lists, as the
// map in view is drawn (`PERIODS`: `day` or the newest, none for a day
// with no above-5% report), stocks by code, holders by key as the map
// links them (`holdersOf`), a code that isn't a stock code's shape left
// out, and the custodians of that day's securities accounts, one each. The stock page's list comes
// from the classification, KSEI and investor-type reports, which can miss a
// stock with holders. At most one day's and one month's rows, each within
// its parse cap (ADR 0045).
export const holderMapSearchList = Effect.fnUntraced(function* (
  day: WibDate | undefined
) {
  const params = [day ?? null]
  const [stockRows = [], spellingRows = [], ...holderRows] =
    yield* (yield* HoldingsDb).batch([
      { ...STOCKS_SQL, params },
      { ...DAY_SPELLINGS_SQL, params },
      { ...PERIODS_SQL, params },
      ...linkRows().map(({ sql, rows }) => ({
        sql: `${PERIODS} ${sql}`,
        params,
        rows,
      })),
    ])
  const isStock = Schema.is(SearchStockRow)
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
    holders: yield* holdersOf(holderRows),
  }
})
