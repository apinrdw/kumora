import { clientRuntime } from "@workspace/client"
import type { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import { parseMarketLiveSearch } from "@/lib/market-live-search"
import { jsonText, makeStoredValue } from "@/lib/stored-value"

// Decision: each browser keeps its own settings in localStorage
// (apps/dashboard/docs/adr/0021-each-browser-keeps-its-own-settings-in-localstorage.md)
const KEY = "kumora:market-live:watchlist"

const NONE: ReadonlyArray<StockCode> = []

// The stored list, its codes parsed as the URL's are: anything else dropped.
const parse = Effect.fnUntraced(function* (raw: string | null) {
  const stored = yield* Effect.try((): unknown => JSON.parse(raw ?? "[]")).pipe(
    Effect.orElseSucceed(() => NONE)
  )
  if (!Array.isArray(stored)) return NONE
  const codes: Array<StockCode> = []
  for (const entry of stored) {
    const { code } = yield* parseMarketLiveSearch({ code: entry })
    if (code !== undefined) codes.push(code)
  }
  return [...new Set(codes)]
})

// Storage blocked reads as no list.
const { subscribe, snapshot, write } = Effect.runSync(
  makeStoredValue({ key: KEY, parse, serialize: jsonText })
)

// The viewer's watchlist codes, in the order added, and its two changes. The
// server render has none.
export function useWatchlist() {
  const codes = useSyncExternalStore(subscribe, snapshot, () => NONE)
  const add = useCallback((code: StockCode) => {
    const held = snapshot()
    if (!held.includes(code)) clientRuntime.runSync(write([...held, code]))
  }, [])
  const remove = useCallback(
    (code: StockCode) =>
      clientRuntime.runSync(write(snapshot().filter((held) => held !== code))),
    []
  )
  return { codes, add, remove }
}
