// The Holder map page (spec apinrdw/kumora#733; apinrdw/kumora#734): a
// stock search, then the focus stock's holders as of one trading day in a
// side panel of two bands, or, with no focus, the stocks with the most ≥1%
// holders.
import { Link } from "@tanstack/react-router"
import type { StockCode, WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { BoundedRows } from "@/components/k/bounded-rows"
import { KEmptyState } from "@/components/k/empty-state"
import { kCard, kFocus } from "@/components/k/styles"
import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { percentOf } from "@/components/stocks/holder-cells"
import { KSEI_TYPE_LABELS } from "@/domain/holdings"
import { count, lotsOfShares } from "@/lib/format"
import type { BandSection, HolderMapView } from "@/lib/holder-map"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"
import type { HolderMapLink } from "@/server/holdings/holder-map"

export type HolderMapPageProps = {
  map: HolderMapView
  list: StockCodeList
  onStock: (code: StockCode) => void
}

const BAND_TITLE: Record<BandSection["band"], string> = {
  "5%": "5% and above",
  "1%": "1% to 5%",
}

const ORIGIN_LABEL: Record<NonNullable<HolderMapLink["origin"]>, string> = {
  local: "Local",
  foreign: "Foreign",
  mixed: "Local and foreign",
}

// The bands' dates: the 5% band's trading day and the 1% band's month.
const datesLine = Effect.fnUntraced(function* (
  day: WibDate | undefined,
  month: WibDate | undefined
) {
  const parts = [
    day === undefined
      ? "No above-5% report parsed"
      : `5% band as of ${yield* dayDateLabel(day)}`,
    month === undefined
      ? "no above-1% report on or before it"
      : `1% band from ${yield* monthLabel(month)}'s report`,
  ]
  return parts.join(" · ")
})

export function HolderMapPage({ map, list, onStock }: HolderMapPageProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 py-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold tracking-tight">
            Holder map
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {Effect.runSync(datesLine(map.day, map.month))}
          </p>
        </div>
        <StockCodePicker
          list={list}
          label="Focus stock"
          placeholder="Search stock code or name"
          className="w-full sm:w-72"
          onPick={onStock}
        />
      </header>
      {map.focus === undefined ? (
        <MostHeld map={map} />
      ) : (
        <Focus focus={map.focus} day={map.day} />
      )}
    </div>
  )
}

function MostHeld({ map }: { map: HolderMapView }) {
  const month = map.month
  return (
    <section
      aria-labelledby="most-held"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <h2 id="most-held" className="text-[15px] font-semibold">
        Stocks with the most ≥1% holders
        {month && ` in ${Effect.runSync(monthLabel(month))}`}
      </h2>
      {map.mostHeld.length === 0 ? (
        <p className="text-muted-foreground">
          No above-1% report is parsed yet. Search a stock to start.
        </p>
      ) : (
        <ol aria-label="Most held stocks" className="flex flex-col">
          {map.mostHeld.map(({ code, issuerName, holders }) => (
            <li key={code} className="border-b border-border last:border-0">
              <Link
                to="/holder-map"
                search={{ stock: code }}
                className={cn(
                  "flex items-baseline gap-3 py-1.5 text-[13px] hover:bg-muted/50",
                  kFocus
                )}
              >
                <span className="w-14 font-semibold">{code}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {issuerName}
                </span>
                <span className="num">
                  {Effect.runSync(count(holders, "holder", "holders"))}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Focus({
  focus,
  day,
}: {
  focus: NonNullable<HolderMapView["focus"]>
  day: WibDate | undefined
}) {
  const empty = focus.bands.every(({ holders }) => holders.length === 0)
  return (
    <section
      aria-labelledby="holder-map-focus"
      className={cn(kCard, "flex flex-col gap-4")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="holder-map-focus" className="text-[17px] font-semibold">
          {focus.code}{" "}
          {focus.issuerName && (
            <span className="font-medium text-muted-foreground">
              {focus.issuerName}
            </span>
          )}
        </h2>
        <Link
          to="/stocks/$code"
          params={{ code: focus.code }}
          className={cn("text-info text-[13px]", kFocus)}
        >
          Open stock page
        </Link>
      </div>
      {empty ? (
        <KEmptyState
          bare
          kind="no-data"
          title={`No holders of ${focus.code}${day === undefined ? "" : ` on ${Effect.runSync(dayDateLabel(day))}`}`}
          description={`Neither the day's above-5% report nor the month's above-1% report lists ${focus.code}. Check the code, or search another stock.`}
        />
      ) : (
        focus.bands.map((band) => <Band key={band.band} band={band} />)
      )}
    </section>
  )
}

function Band({ band }: { band: BandSection }) {
  const title = BAND_TITLE[band.band]
  const id = `band-${band.band === "5%" ? "5" : "1"}`
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={id} className="text-[15px] font-semibold">
          {title}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {Effect.runSync(count(band.holders.length, "holder", "holders"))} ·{" "}
          {Effect.runSync(percentOf(band.totalHundredths))}
          {band.date &&
            ` · ${Effect.runSync(
              band.band === "5%"
                ? dayDateLabel(band.date)
                : monthLabel(band.date)
            )}`}
        </p>
      </div>
      {band.holders.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No holder in this band.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            aria-label={title}
            className="w-full text-[13px] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_tr]:border-b [&_tr]:border-border"
          >
            <thead className="[&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
              <tr>
                <th scope="col" className="text-left">
                  Holder
                </th>
                <th scope="col" className="text-right">
                  % of listed
                </th>
                <th scope="col" className="text-right">
                  Lots
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Decision: a page renders a list of stored rows through BoundedRows
                  (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
              <BoundedRows rows={band.holders}>
                {(holder) => <HolderRow key={holder.holder} holder={holder} />}
              </BoundedRows>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function HolderRow({ holder }: { holder: HolderMapLink }) {
  const meta = [
    holder.origin === undefined
      ? "Origin unknown"
      : ORIGIN_LABEL[holder.origin],
    holder.investorType === undefined
      ? "Type unknown"
      : KSEI_TYPE_LABELS[holder.investorType],
  ]
  return (
    <tr>
      <th scope="row" className="text-left font-normal">
        <div className="font-medium">{holder.name}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          {meta.join(" · ")}
        </div>
      </th>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(percentOf(holder.percentageHundredths))}
      </td>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(lotsOfShares(holder.shares))}
      </td>
    </tr>
  )
}
