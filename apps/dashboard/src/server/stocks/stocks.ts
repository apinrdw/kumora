// The stock page's server side, /stocks/$CODE (spec apinrdw/kumora#363,
// "Stock page UI"): open to every signed-in member, through the access
// policy's `stocks` feature.
import { StockCode } from "@workspace/relay"
import { NotFound } from "@workspace/server"
import { Effect, Option, Schema } from "effect"

import type { InventoryWindow } from "@/lib/broker-inventory"
import { Auth } from "@/server/auth/auth"
import { decide } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf } from "@/server/auth/session-account"
import type { HolderMapQuery, MovesSelection } from "@/domain/holdings"
import { brokerInventory } from "@/server/broker-totals/inventory"
import { holderMapRead } from "@/server/holdings/holder-map"
import { holderMapSearchList } from "@/server/holdings/holder-map-search-list"
import { holderMovesRead } from "@/server/holdings/holder-moves"
import { stockList, stockPage } from "@/server/holdings/stock-page"
import { marketToday } from "@/server/market-live/market-clock"

const authorize = Effect.fnUntraced(function* (headers: Headers, href: string) {
  const session = yield* (yield* Auth).getSession(headers)
  const decision = yield* decide(yield* accountOf(session), "stocks.view", {
    feature: "stocks",
  })
  if (decision._tag === "Deny") return yield* refusal(decision.reason, href)
})

// A code that isn't a stock code is not found, so a typo never reads as a
// stock with no data.
const stockCode = Effect.fnUntraced(function* (code: string) {
  const stock = Schema.decodeUnknownOption(StockCode)(code)
  if (Option.isNone(stock)) return yield* new NotFound({ message: "" })
  return stock.value
})

// `month` is the URL's, `YYYY-MM`.
export const stockPageView = Effect.fn("stockPageView")(function* (
  headers: Headers,
  code: string,
  month: string | undefined
) {
  yield* authorize(headers, `/stocks/${encodeURIComponent(code)}`)
  return yield* stockPage(yield* stockCode(code), month)
})

// The Broker inventory tab's read, as of today on Market Live's clock.
export const brokerInventoryView = Effect.fn("brokerInventoryView")(function* (
  headers: Headers,
  code: string,
  window: InventoryWindow
) {
  yield* authorize(headers, `/stocks/${encodeURIComponent(code)}?tab=brokers`)
  return yield* brokerInventory(
    yield* stockCode(code),
    window,
    yield* marketToday
  )
})

export const stockListView = Effect.fn("stockListView")(function* (
  headers: Headers,
  href: string
) {
  yield* authorize(headers, href)
  return yield* stockList
})

// /holder-moves' read, open to every signed-in member as the stock page is.
export const holderMapPageView = Effect.fn("holderMapPageView")(function* (
  headers: Headers,
  query: HolderMapQuery
) {
  yield* authorize(headers, "/holder-map")
  return yield* holderMapRead(query)
})

// The Holder map search's stocks, holders and custodians; `href` is the page the visitor returns
// to after signing in again.
export const holderMapSearchListView = Effect.fn("holderMapSearchListView")(
  function* (headers: Headers, href: string) {
    yield* authorize(headers, href)
    return yield* holderMapSearchList
  }
)

export const holderMovesPageView = Effect.fn("holderMovesPageView")(function* (
  headers: Headers,
  selection: MovesSelection
) {
  yield* authorize(headers, "/holder-moves")
  return yield* holderMovesRead(selection)
})
