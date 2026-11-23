// The stock this browser last opened, for bare /stocks (spec
// apinrdw/kumora#363, "Stock page UI").
import { StockCode } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { DEFAULT_CODE } from "@/lib/market-live-search"

// Decision: each browser keeps its own settings in localStorage
// (apps/dashboard/docs/adr/0021-each-browser-keeps-its-own-settings-in-localstorage.md)
const KEY = "kumora:stocks:last"

// Storage blocked, or a stored value that isn't a stock code, reads as none:
// Market Live's default code.
export const lastStock = Effect.try(() =>
  window.localStorage.getItem(KEY)
).pipe(
  Effect.map((stored) =>
    Option.getOrElse(
      Schema.decodeUnknownOption(StockCode)(stored),
      () => DEFAULT_CODE
    )
  ),
  Effect.orElseSucceed(() => DEFAULT_CODE)
)

// Storage blocked: nothing is kept.
export const rememberStock = (code: StockCode) =>
  Effect.try(() => window.localStorage.setItem(KEY, code)).pipe(Effect.ignore)
