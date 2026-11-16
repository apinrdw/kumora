import { createFileRoute } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"
import { useCallback, useEffect } from "react"

import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { HolderSize } from "@/components/stocks/holder-size"
import { HoldingComposition } from "@/components/stocks/holding-composition"
import { ShareholdersComposition } from "@/components/stocks/shareholders-composition"
import { useStockList } from "@/components/stocks/use-stock-list"
import { rememberStock } from "@/lib/last-stock"
import { parseStockSearch, type StockSearch } from "@/lib/stock-search"
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
  const {
    panel = "all",
    chart = "all",
    view = "bars",
    sizeMonth,
    sizeOrigin = "all",
    sizeBase = "outstanding",
  } = Route.useSearch()
  const navigate = Route.useNavigate()
  const list = useStockList(`/stocks/${page.code}`)
  // Bare /stocks opens it next time.
  useEffect(() => {
    clientRuntime.runFork(rememberStock(page.code))
  }, [page.code])
  const newest = page.months.filter(({ held }) => held).at(-1)?.dataDate
  const newestSize = page.holderSize
    .filter(({ holding }) => holding !== undefined)
    .at(-1)?.dataDate
  // A stock any source has, even one with no composition.
  const known =
    page.composition !== undefined || page.inKsei || newestSize !== undefined
  // Each control changes its own search param, at its default left out.
  const setSearch = useCallback(
    (change: StockSearch) =>
      void navigate({
        search: (previous: StockSearch) => ({ ...previous, ...change }),
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
          {known
            ? `${page.code} isn't in IDX's classification report, so its shareholders composition isn't shown.`
            : `No holdings data for ${page.code}. Pick another stock.`}
        </p>
      ) : (
        <ShareholdersComposition
          page={{ ...page, composition: page.composition }}
          origin={panel}
          onMonth={(dataDate) =>
            setSearch({
              month: dataDate === newest ? undefined : dataDate.slice(0, 7),
            })
          }
          onOrigin={(origin) =>
            setSearch({ panel: origin === "all" ? undefined : origin })
          }
        />
      )}
      {known && (
        <HolderSize
          code={page.code}
          months={page.holderSize}
          month={sizeMonth}
          origin={sizeOrigin}
          denominator={sizeBase}
          onMonth={(dataDate) =>
            setSearch({
              sizeMonth:
                dataDate === newestSize ? undefined : dataDate.slice(0, 7),
            })
          }
          onOrigin={(origin) =>
            setSearch({ sizeOrigin: origin === "all" ? undefined : origin })
          }
          onDenominator={(denominator) =>
            setSearch({
              sizeBase: denominator === "outstanding" ? undefined : denominator,
            })
          }
        />
      )}
      {page.series.length > 0 && (
        <HoldingComposition
          key={page.code}
          series={page.series}
          origin={chart}
          view={view}
          onOrigin={(origin) =>
            setSearch({ chart: origin === "all" ? undefined : origin })
          }
          onView={(next) =>
            setSearch({ view: next === "bars" ? undefined : next })
          }
        />
      )}
    </div>
  )
}
