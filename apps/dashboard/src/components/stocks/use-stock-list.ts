import { isRedirect } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect, Fiber } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

import { signInAgain } from "@/components/market-live/sign-in-again"
import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import { stockListFn } from "@/server/stocks/stocks.functions"

const LOADING: StockCodeList = { _tag: "Loading" }

// The stocks with parsed holdings, in the pickers' shape. `href` is the page
// the visitor returns to after signing in again: a 401 arrives as the
// router's redirect, and sends them there, the list still loading. Fails as
// the call does, with a warning logged.
export const loadStockList = (href: string) =>
  Effect.tryPromise({
    try: () => stockListFn({ data: href }),
    catch: (thrown) => thrown,
  }).pipe(
    Effect.map((stocks): StockCodeList => ({
      _tag: "Ready",
      codes: stocks.map(({ code, issuerName }) => ({
        code,
        name: issuerName ?? "",
        kind: "share",
      })),
    })),
    Effect.catchIf(isRedirect, () => Effect.as(signInAgain, LOADING)),
    Effect.tapError((error) =>
      Effect.logWarning("Stock list not loaded", error)
    )
  )

// The stock page picker's stocks, loaded once the page opens. A failed load
// keeps the picker loading; the page itself still shows.
export function useStockList(href: string): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      loadStockList(href).pipe(
        Effect.tap((loaded) => Effect.sync(() => setList(loaded))),
        Effect.ignore
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [href])
  return list
}

// The Shell's stock search list: none until `load` is first called, then
// kept for every page. A failed load stays loading, and the next `load` asks
// again.
export function useStockListOnDemand(): [
  StockCodeList,
  (href: string) => void,
] {
  const [list, setList] = useState<StockCodeList>(LOADING)
  const asked = useRef(false)
  const load = useCallback((href: string) => {
    if (asked.current) return
    asked.current = true
    clientRuntime.runFork(
      loadStockList(href).pipe(
        Effect.match({
          onSuccess: setList,
          onFailure: () => {
            asked.current = false
          },
        })
      )
    )
  }, [])
  return [list, load]
}
