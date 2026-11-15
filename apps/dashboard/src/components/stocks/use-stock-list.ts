import { useEffect, useState } from "react"

import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import { stockListFn } from "@/server/stocks/stocks.functions"

// The stock page picker's stocks, loaded once the page opens. A failed load
// keeps the picker loading; the page itself still shows.
export function useStockList(href: string): StockCodeList {
  const [list, setList] = useState<StockCodeList>({ _tag: "Loading" })
  useEffect(() => {
    let current = true
    stockListFn({ data: href }).then(
      (stocks) => {
        if (current)
          setList({
            _tag: "Ready",
            codes: stocks.map(({ code, issuerName }) => ({
              code,
              name: issuerName,
              kind: "share",
            })),
          })
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [href])
  return list
}
