import type { StockCode } from "@workspace/relay"
import { useCallback, useSyncExternalStore } from "react"

import { parseMarketLiveSearch } from "@/lib/market-live-search"

// Decision: each browser keeps its own watchlist in localStorage (spec
// apinrdw/kumora#138, "Watchlist"), not on the account. The e2e seeds the
// key (apps/e2e/tests/market-live-watchlist.spec.ts).
const KEY = "kumora:market-live:watchlist"

const NONE: ReadonlyArray<StockCode> = []

// The stored list, its codes parsed as the URL's are: anything else dropped.
const parse = (raw: string | null): ReadonlyArray<StockCode> => {
  try {
    const stored: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(stored)) return NONE
    const codes = stored.flatMap(
      (entry) => parseMarketLiveSearch({ code: entry }).code ?? []
    )
    return [...new Set(codes)]
  } catch {
    return NONE
  }
}

const read = (): string | null => {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

// The list as last read, kept while the stored text is unchanged, so React
// sees the same array.
let cached: { raw: string | null; codes: ReadonlyArray<StockCode> } = {
  raw: null,
  codes: NONE,
}
const snapshot = () => {
  const raw = read()
  if (raw !== cached.raw) cached = { raw, codes: parse(raw) }
  return cached.codes
}

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Another tab's change.
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

const write = (codes: ReadonlyArray<StockCode>) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(codes))
  } catch {
    // Storage blocked: the list lasts as long as the page.
    cached = { raw: cached.raw, codes }
  }
  for (const listener of listeners) listener()
}

// The viewer's watchlist codes, in the order added, and its two changes. The
// server render has none.
export function useWatchlist() {
  const codes = useSyncExternalStore(subscribe, snapshot, () => NONE)
  const add = useCallback((code: StockCode) => {
    const held = snapshot()
    if (!held.includes(code)) write([...held, code])
  }, [])
  const remove = useCallback(
    (code: StockCode) => write(snapshot().filter((held) => held !== code)),
    []
  )
  return { codes, add, remove }
}
