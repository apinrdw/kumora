import { createFileRoute } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo } from "react"

import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { BrokerInventory } from "@/components/stocks/broker-inventory"
import { HolderSize } from "@/components/stocks/holder-size"
import { HoldingComposition } from "@/components/stocks/holding-composition"
import { MajorHolders } from "@/components/stocks/major-holders"
import { ShareholdersComposition } from "@/components/stocks/shareholders-composition"
import { useStockList } from "@/components/stocks/use-stock-list"
import { rememberStock } from "@/lib/last-stock"
import {
  chipsOf,
  chipsSearch,
  inventoryWindow,
  lensOf,
  lensSearch,
  parseStockSearch,
  pickerSearch,
  selectionOf,
  type StockSearch,
  type Tab,
  windowSearch,
} from "@/lib/stock-search"
import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"
import type { StockPage } from "@/server/holdings/stock-page"
import {
  brokerInventoryFn,
  stockPageFn,
} from "@/server/stocks/stocks.functions"

interface StockPageData {
  readonly page: StockPage
  // Only on the Broker inventory tab.
  readonly inventory: BrokerInventoryRead | undefined
}

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "holdings", label: "Holdings" },
  { value: "brokers", label: "Broker inventory" },
]

export const Route = createFileRoute("/_app/stocks/$code")({
  staticData: {
    feature: "stocks",
    crumbs: ({ code = "" }) =>
      Effect.succeed([{ label: "Stocks" }, { label: code }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseStockSearch(raw)),
  // The range only on its tab, so the holdings never reload for it.
  loaderDeps: ({ search }) => ({
    month: search.month,
    inventory:
      search.tab === "brokers"
        ? Effect.runSync(inventoryWindow(search))
        : undefined,
  }),
  // Declared, so the route's type doesn't depend on itself through
  // loadServerFn.
  loader: ({ params, deps }): Promise<StockPageData> =>
    runLoader(
      Effect.all(
        {
          page: loadServerFn(() =>
            stockPageFn({ data: { code: params.code, month: deps.month } })
          ),
          inventory:
            deps.inventory === undefined
              ? Effect.succeed(undefined)
              : loadServerFn(() =>
                  brokerInventoryFn({
                    data: { code: params.code, window: deps.inventory },
                  })
                ),
        },
        { concurrency: "unbounded" }
      )
    ),
  head: ({ params }) => ({
    meta: [{ title: `${params.code} · KUMORA Terminal` }],
  }),
  component: StockPageView,
})

function StockPageView() {
  const { page, inventory }: StockPageData = Route.useLoaderData()
  const search = Route.useSearch()
  const tab = search.tab ?? "holdings"
  const navigate = Route.useNavigate()
  // Stable while their params are, so the tab's figures recompute only when
  // one changes.
  const lens = useMemo(
    () =>
      Effect.runSync(
        lensOf({ measure: search.measure, investor: search.investor })
      ),
    [search.measure, search.investor]
  )
  const chips = useMemo(
    () => Effect.runSync(chipsOf({ brokers: search.brokers })),
    [search.brokers]
  )
  // Dropped while it reaches outside the read's days.
  const selection = useMemo(
    () =>
      inventory === undefined
        ? undefined
        : Effect.runSync(
            selectionOf(
              { selFrom: search.selFrom, selTo: search.selTo },
              inventory.days
            )
          ),
    [inventory, search.selFrom, search.selTo]
  )
  const list = useStockList(`/stocks/${page.code}`)
  // Bare /stocks opens it next time.
  useEffect(() => {
    clientRuntime.runFork(rememberStock(page.code))
  }, [page.code])
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
  // A link's selection that falls outside the read's days leaves the URL.
  const staleSelection =
    inventory !== undefined &&
    search.selFrom !== undefined &&
    selection === undefined
  useEffect(() => {
    if (staleSelection) setSearch({ selFrom: undefined, selTo: undefined })
  }, [staleSelection, setSearch])
  return (
    // Decision: the Broker inventory tab takes the page's full width, for a
    // long range's days. See apinrdw/kumora#421, "Amended 2026-11-16".
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-4 py-2",
        tab === "holdings" && "max-w-[1080px]"
      )}
    >
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
            void navigate({
              to: "/stocks/$code",
              params: { code },
              search: Effect.runSync(pickerSearch(search)),
            })
          }
        />
      </header>
      <div
        role="tablist"
        aria-label="Stock views"
        className="flex gap-4 border-b border-border text-[13px]"
      >
        {TABS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={value === tab}
            onClick={() =>
              setSearch({ tab: value === "holdings" ? undefined : value })
            }
            className={cn(
              "-mb-px border-b-2 py-2",
              value === tab
                ? "border-foreground font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {inventory !== undefined && tab === "brokers" ? (
        <BrokerInventory
          code={page.code}
          read={inventory}
          window={Effect.runSync(inventoryWindow(search))}
          lens={lens}
          chips={chips}
          selection={selection}
          onWindow={(window) => setSearch(Effect.runSync(windowSearch(window)))}
          onLens={(next) => setSearch(Effect.runSync(lensSearch(next)))}
          onChips={(next) => setSearch(Effect.runSync(chipsSearch(next)))}
          onSelection={(span) =>
            setSearch({
              selFrom: span && inventory.days[span[0]],
              selTo: span && inventory.days[span[1]],
            })
          }
        />
      ) : (
        <Holdings page={page} setSearch={setSearch} />
      )}
    </div>
  )
}

// The Holdings tab: the stock's KSEI and IDX holdings panels.
function Holdings({
  page,
  setSearch,
}: {
  page: StockPage
  setSearch: (change: StockSearch) => void
}) {
  const { panel = "all", chart = "all", view = "bars" } = Route.useSearch()
  const newest = page.months.filter(({ held }) => held).at(-1)?.dataDate
  const newestSize = page.holderSize
    .filter(({ holding }) => holding !== undefined)
    .at(-1)?.dataDate
  // A stock any source has, even one with no composition.
  const known =
    page.composition !== undefined || page.inKsei || newestSize !== undefined
  return (
    <>
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
        <StockHolderSize
          page={page}
          newest={newestSize}
          setSearch={setSearch}
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
      {known && <StockMajorHolders page={page} setSearch={setSearch} />}
    </>
  )
}

// Major holders with its month param, left out for its newest held month.
function StockMajorHolders({
  page,
  setSearch,
}: {
  page: StockPage
  setSearch: (change: StockSearch) => void
}) {
  const { holdersMonth } = Route.useSearch()
  const newest = page.majorHolders
    .filter(({ holders }) => holders.length > 0)
    .at(-1)?.dataDate
  return (
    <MajorHolders
      code={page.code}
      months={page.majorHolders}
      month={holdersMonth}
      onMonth={(dataDate) =>
        setSearch({
          holdersMonth: dataDate === newest ? undefined : dataDate.slice(0, 7),
        })
      }
    />
  )
}

// Holder size with its search params. `newest` is its newest held month.
function StockHolderSize({
  page,
  newest,
  setSearch,
}: {
  page: StockPage
  newest: string | undefined
  setSearch: (change: StockSearch) => void
}) {
  const {
    sizeMonth,
    sizeOrigin = "all",
    sizeBase = "outstanding",
    sizeView = "bars",
  } = Route.useSearch()
  return (
    <HolderSize
      code={page.code}
      months={page.holderSize}
      month={sizeMonth}
      origin={sizeOrigin}
      denominator={sizeBase}
      view={sizeView}
      onMonth={(dataDate) =>
        setSearch({
          sizeMonth: dataDate === newest ? undefined : dataDate.slice(0, 7),
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
      onView={(next) =>
        setSearch({ sizeView: next === "bars" ? undefined : next })
      }
    />
  )
}
