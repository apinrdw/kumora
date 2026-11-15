// The stock page's server side, /stocks/$CODE (spec apinrdw/kumora#363,
// "Stock page UI"): open to every signed-in member, through the access
// policy's `stocks` feature.
import { StockCode } from "@workspace/relay"
import { NotFound } from "@workspace/server"
import { Effect, Option, Schema } from "effect"

import { Auth } from "@/server/auth/auth"
import { decide } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf } from "@/server/auth/session-account"
import { stockList, stockPage } from "@/server/holdings/stock-page"

const authorize = Effect.fnUntraced(function* (headers: Headers, href: string) {
  const session = yield* (yield* Auth).getSession(headers)
  const decision = yield* decide(yield* accountOf(session), "stocks.view", {
    feature: "stocks",
  })
  if (decision._tag === "Deny") return yield* refusal(decision.reason, href)
})

// A code that isn't a stock code is not found, so a typo never reads as a
// stock with no data. `month` is the URL's, `YYYY-MM`.
export const stockPageView = Effect.fn("stockPageView")(function* (
  headers: Headers,
  code: string,
  month: string | undefined
) {
  yield* authorize(headers, `/stocks/${encodeURIComponent(code)}`)
  const stock = Schema.decodeUnknownOption(StockCode)(code)
  if (Option.isNone(stock)) return yield* new NotFound({ message: "" })
  return yield* stockPage(stock.value, month)
})

export const stockListView = Effect.fn("stockListView")(function* (
  headers: Headers,
  href: string
) {
  yield* authorize(headers, href)
  return yield* stockList
})
