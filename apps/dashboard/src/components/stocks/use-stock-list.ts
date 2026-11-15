import { useCallback, useEffect, useRef, useState } from "react"

import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import { stockListFn } from "@/server/stocks/stocks.functions"

const LOADING: StockCodeList = { _tag: "Loading" }

// The stocks with parsed holdings, in the pickers' shape. `href` is the page
// the visitor returns to after signing in again.
const loadStockList = (href: string) =>
  stockListFn({ data: href }).then((stocks): StockCodeList => ({
    _tag: "Ready",
    codes: stocks.map(({ code, issuerName }) => ({
      code,
      name: issuerName,
      kind: "share",
    })),
  }))

// The stock page picker's stocks, loaded once the page opens. A failed load
// keeps the picker loading; the page itself still shows.
export function useStockList(href: string): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  useEffect(() => {
    let current = true
    loadStockList(href).then(
      (loaded) => {
        if (current) setList(loaded)
      },
      () => undefined
    )
    return () => {
      current = false
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
    loadStockList(href).then(setList, () => {
      asked.current = false
    })
  }, [])
  return [list, load]
}
