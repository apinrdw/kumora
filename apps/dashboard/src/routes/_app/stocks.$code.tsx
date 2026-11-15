import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"
import { useCallback } from "react"

import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { ShareholdersComposition } from "@/components/stocks/shareholders-composition"
import { useStockList } from "@/components/stocks/use-stock-list"
import {
  type PanelOrigin,
  parseStockSearch,
  type StockSearch,
} from "@/lib/stock-search"
import type { StockPage } from "@/server/holdings/stock-page"
import { stockPageFn } from "@/server/stocks/stocks.functions"

export const Route = createFileRoute("/_app/stocks/$code")({
  staticData: {
    feature: "stocks",
    crumbs: ({ code = "" }) =>
      Effect.succeed([{ label: "Stocks" }, { label: code }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseStockSearch(raw)),
  loaderDeps: ({ search }) => ({ month: search.month }),
  // Declared, so the route's type doesn't depend on itself through
  // loadServerFn.
  loader: ({ params, deps }): Promise<StockPage> =>
    runLoader(
      loadServerFn(() =>
        stockPageFn({ data: { code: params.code, month: deps.month } })
      )
    ),
  head: ({ params }) => ({
    meta: [{ title: `${params.code} · KUMORA Terminal` }],
  }),
  component: StockPageView,
})

function StockPageView() {
  const page: StockPage = Route.useLoaderData()
  const { panel = "all" } = Route.useSearch()
  const navigate = Route.useNavigate()
  const list = useStockList(`/stocks/${page.code}`)
  const newest = page.months.filter(({ held }) => held).at(-1)?.dataDate
  const onMonth = useCallback(
    (dataDate: string) =>
      void navigate({
        search: (previous: StockSearch) => ({
          ...previous,
          month: dataDate === newest ? undefined : dataDate.slice(0, 7),
        }),
        replace: true,
        resetScroll: false,
      }),
    [navigate, newest]
  )
  const onOrigin = useCallback(
    (origin: PanelOrigin) =>
      void navigate({
        search: (previous: StockSearch) => ({
          ...previous,
          panel: origin === "all" ? undefined : origin,
        }),
        replace: true,
        resetScroll: false,
      }),
    [navigate]
  )
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 py-2">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">
          {page.code}{" "}
          {page.issuerName && (
            <span className="font-medium text-muted-foreground">
              {page.issuerName}
            </span>
          )}
        </h1>
        <StockCodePicker
          list={list}
          label="Stock"
          placeholder="Switch stock"
          className="w-full sm:w-72"
          onPick={(code) =>
            void navigate({ to: "/stocks/$code", params: { code } })
          }
        />
      </header>
      {page.composition === undefined ? (
        <p className="text-muted-foreground">
          {page.inKsei
            ? `${page.code} isn't in IDX's classification report, so its shareholders composition isn't shown.`
            : `No holdings data for ${page.code}. Pick another stock.`}
        </p>
      ) : (
        <ShareholdersComposition
          page={{ ...page, composition: page.composition }}
          origin={panel}
          onMonth={onMonth}
          onOrigin={onOrigin}
        />
      )}
    </div>
  )
}
