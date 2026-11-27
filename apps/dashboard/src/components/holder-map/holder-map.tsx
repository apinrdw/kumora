// The Holder map page (spec apinrdw/kumora#733; apinrdw/kumora#734, #736):
// a stock search, then the focus stock's holders as of one trading day in a
// side panel of two bands, each with its move, and its Off list holders, or,
// with no focus, the stocks with the most ≥1% holders.
import { Link } from "@tanstack/react-router"
import type { StockCode, WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useState } from "react"

import { BoundedRows } from "@/components/k/bounded-rows"
import { KChip } from "@/components/k/chip"
import { KEmptyState } from "@/components/k/empty-state"
import { kCard, kFocus } from "@/components/k/styles"
import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import {
  Delta,
  lotsChangeText,
  MoveChip,
  offListText,
  percentChangeText,
  percentOf,
} from "@/components/stocks/holder-cells"
import { MOVEMENT } from "@/components/stocks/holder-movement"
import { KSEI_TYPE_LABELS } from "@/domain/holdings"
import { count, lotsOfShares } from "@/lib/format"
import type {
  BandSection,
  HolderMapView,
  MapHolder,
  ShownMove,
} from "@/lib/holder-map"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"
import type {
  HolderMapLink,
  HolderMapOffList,
} from "@/server/holdings/holder-map"

export type HolderMapPageProps = {
  map: HolderMapView
  list: StockCodeList
  onStock: (code: StockCode) => void
}

const BAND_TITLE: Record<BandSection["band"], string> = {
  "5%": "5% and above",
  "1%": "1% to 5%",
}

// A link's move as the side panel's chip shows it: Holder moves' chips,
// and a crossing of 5% toned as the Up or Down it is.
const SHOWN_MOVE: Record<
  ShownMove,
  { readonly label: string; readonly text: string; readonly chip: string }
> = {
  new: MOVEMENT.new,
  up: MOVEMENT.up,
  down: MOVEMENT.down,
  transfer: MOVEMENT.transfer,
  unchanged: MOVEMENT.unchanged,
  "up into 5%": { ...MOVEMENT.up, label: "Up into 5%" },
  "down out of 5%": { ...MOVEMENT.down, label: "Down out of 5%" },
}

// The period a band's report is of: a trading day or an above-1% month.
const periodLabel = (band: BandSection["band"], date: WibDate) =>
  band === "5%" ? dayDateLabel(date) : monthLabel(date)

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
        focus.bands.map((band) => (
          <Band key={band.band} band={band} day={day} />
        ))
      )}
      <OffList holders={focus.offList} />
    </section>
  )
}

function Band({ band, day }: { band: BandSection; day: WibDate | undefined }) {
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
                <th scope="col" className="text-left">
                  Move
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
                {(holder) => (
                  <HolderRow key={holder.holder} holder={holder} day={day} />
                )}
              </BoundedRows>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function HolderRow({
  holder,
  day,
}: {
  holder: MapHolder
  day: WibDate | undefined
}) {
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
        {holder.gap && day !== undefined && (
          <div className="text-warning mt-0.5 text-[12px]">
            ≥5% at month-end, not on {Effect.runSync(dayDateLabel(day))}'s
            above-5% list
          </div>
        )}
      </th>
      <td className="text-left">
        <ShownMoveCell holder={holder} />
      </td>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(percentOf(holder.percentageHundredths))}
      </td>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(lotsOfShares(holder.shares))}
      </td>
    </tr>
  )
}

// The chip of a holder's shown move, and under it what changed: a crossing's
// other side, or the move's change in % and lots.
function ShownMoveCell({ holder }: { holder: MapHolder }) {
  const { label, text, chip } = SHOWN_MOVE[holder.shownMove]
  const { crossing, move } = holder
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className={cn(
          "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap",
          text,
          chip
        )}
      >
        {label}
      </span>
      {crossing?.kind === "up into 5%" && (
        <div className="text-[12px] text-muted-foreground">
          {Effect.runSync(percentOf(crossing.monthHundredths))} at month-end
        </div>
      )}
      {crossing?.kind === "down out of 5%" && (
        <div className="text-[12px] text-muted-foreground">
          Off the above-5% list since{" "}
          {Effect.runSync(dayDateLabel(crossing.since))}
        </div>
      )}
      {crossing === undefined && move !== undefined && (
        <>
          <Delta value={move.percentageChange} text={percentChangeText} />
          <Delta value={move.shareChange} text={lotsChangeText} />
        </>
      )}
    </div>
  )
}

// The focus's earlier holders, each with the period it left its list,
// hidden by the toggle.
function OffList({ holders }: { holders: ReadonlyArray<HolderMapOffList> }) {
  const [shown, setShown] = useState(true)
  if (holders.length === 0) return null
  return (
    <section aria-labelledby="off-list" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="off-list" className="text-[15px] font-semibold">
          Off list
        </h3>
        <KChip
          selected={shown}
          onSelectedChange={setShown}
          count={holders.length}
        >
          Show Off list
        </KChip>
      </div>
      {shown && (
        <ul aria-label="Off list holders" className="flex flex-col text-[13px]">
          {/* Decision: a page renders a list of stored rows through BoundedRows
              (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
          <BoundedRows rows={holders}>
            {(holder) => <OffListRow key={holder.holder} holder={holder} />}
          </BoundedRows>
        </ul>
      )}
    </section>
  )
}

function OffListRow({ holder }: { holder: HolderMapOffList }) {
  const since = Effect.runSync(periodLabel(holder.band, holder.since))
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-1.5 text-muted-foreground opacity-80 last:border-0">
      <span className="font-medium">{holder.name}</span>
      <span className="flex items-baseline gap-2">
        <span className="num">
          {Effect.runSync(percentOf(holder.percentageHundredths))} last
        </span>
        <MoveChip
          move="off list"
          since={since}
          offListTip={Effect.runSync(
            offListText(holder.band === "5%" ? "daily" : "monthly")
          )}
        />
      </span>
    </li>
  )
}
