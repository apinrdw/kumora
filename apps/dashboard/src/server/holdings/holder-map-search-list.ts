// What the Holder map's search offers (spec apinrdw/kumora#733, story 2):
// the stocks, holders and custodians it can focus.
import type { BrokerCode } from "@workspace/relay"
import { StockCode } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { type CustodianId, HolderKey } from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"
import {
  custodianNames,
  custodianOf,
  SpellingRow,
} from "./holder-map-custodians.ts"

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

const NEWEST_DAY = "(SELECT MAX(data_date) FROM above_5_day)"
const NEWEST_MONTH = "(SELECT MAX(data_date) FROM above_1_month)"

// The stocks and holders the newest above-5% day or the newest above-1%
// month lists, stocks by code, holders by key with a name of theirs, a code
// that isn't a stock code's shape left out, and the custodians of the
// newest day's securities accounts, one each. The stock page's list comes
// from the classification, KSEI and investor-type reports, which can miss a
// stock with holders. At most one day's and one month's rows, each within
// its parse cap (ADR 0045).
export const holderMapSearchList = Effect.gen(function* () {
  const [stockRows = [], holderRows = [], spellingRows = []] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: `SELECT stock_code, MAX(issuer_name) AS issuer_name FROM (
          SELECT stock_code, issuer_name FROM above_5_holder
          WHERE data_date = ${NEWEST_DAY}
          UNION ALL
          SELECT stock_code, issuer_name FROM above_1_holding
          WHERE data_date = ${NEWEST_MONTH}
        )
        GROUP BY stock_code ORDER BY stock_code`,
        params: [],
      },
      {
        sql: `SELECT holder_key, MAX(name) AS name FROM (
          SELECT holder_key, holder_name AS name FROM above_5_holder
          WHERE data_date = ${NEWEST_DAY}
          UNION ALL
          SELECT holder_key, investor_name AS name FROM above_1_holding
          WHERE data_date = ${NEWEST_MONTH}
        )
        GROUP BY holder_key ORDER BY name`,
        params: [],
      },
      {
        sql: `SELECT DISTINCT custodian FROM above_5_account
        WHERE data_date = ${NEWEST_DAY}`,
        params: [],
      },
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
