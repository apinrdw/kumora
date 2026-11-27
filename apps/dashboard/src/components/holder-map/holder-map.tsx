// The Holder map page (spec apinrdw/kumora#733; apinrdw/kumora#734,
// #735, #736, #737, #738, #739): a stock, holder and custodian search and
// an as-of day picker, then the focus's holdings as of one trading day,
// drawn as a map above a side panel of two bands, each with its move, the
// custodians drawn, and its Off list, or, with no focus, the stocks with
// the most ≥1% holders. A stock focus's holdings are its holders, a holder
// focus's its stocks, and a custodian focus's book its holders and stocks.
import { Link } from "@tanstack/react-router"
import type { WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type { ReactNode } from "react"

import { BoundedRows } from "@/components/k/bounded-rows"
import { KChip } from "@/components/k/chip"
import { KEmptyState } from "@/components/k/empty-state"
import { kCard, kFocus } from "@/components/k/styles"
import { DayPicker } from "@/components/stocks/day-picker"
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
  CustodianBook,
  FocusView,
  HolderMapView,
  MapHolder,
} from "@/lib/holder-map"
import {
  BAND_TITLE,
  type MapCustodian,
  ORIGIN_LABEL,
  type Refocus,
  type ShownMove,
} from "@/lib/holder-map-graph"
import { type FocusMatch, refocused } from "@/lib/holder-map-search"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"
import type { HolderMapOffList } from "@/server/holdings/holder-map-schema"

import { FocusPicker } from "./focus-picker"
import { HolderMapGraph } from "./holder-map-graph"
import type { FocusListState } from "./use-focus-list"

export type HolderMapPageProps = {
  map: HolderMapView
  list: FocusListState
  onRefocus: (refocus: Refocus) => void
  onDay: (day: WibDate) => void
  // The URL's Off list filter: shown unless `offList=hide`.
  showOffList: boolean
  onShowOffList: (shown: boolean) => void
}

// A search match's refocus.
const refocusOf = (match: FocusMatch) =>
  Effect.succeed<Refocus>(
    match.kind === "stock"
      ? { stock: match.code }
      : match.kind === "holder"
        ? { holder: match.key }
        : { custodian: match.id }
  )

// What a focus's heading says it is.
const kindLabel = (focus: FocusView) =>
  Effect.succeed(
    focus.kind === "stock"
      ? focus.issuerName
      : focus.kind === "holder"
        ? "Holder"
        : focus.broker === undefined
          ? "Custodian"
          : `Custodian · ${focus.broker}`
  )

// A focus with nothing to draw: a stock with no holders, a holder with no
// stocks, a custodian holding for no one.
const emptyText = Effect.fnUntraced(function* (
  focus: FocusView,
  day: WibDate | undefined
) {
  const on = day === undefined ? "" : ` on ${yield* dayDateLabel(day)}`
  if (focus.kind === "custodian")
    return {
      title: `Nothing held through ${focus.title}${on}`,
      description: `No securities account on the day's above-5% report is at ${focus.title}. Search another custodian, or pick another day.`,
    }
  return {
    title: `${focus.kind === "stock" ? "No holders of" : "No stocks held by"} ${focus.title}${on}`,
    description: `Neither the day's above-5% report nor the month's above-1% report lists ${focus.title}. ${focus.kind === "stock" ? "Check the code, or search another stock." : "Search another stock or holder."}`,
  }
})

// A link to the map refocused, keeping the day picked.
function RefocusLink({
  to,
  children,
  className,
}: {
  to: Refocus
  children: ReactNode
  className?: string
}) {
  return (
    <Link
      to="/holder-map"
      search={(previous) => Effect.runSync(refocused(previous, to))}
      className={cn("hover:underline", kFocus, className)}
    >
      {children}
    </Link>
  )
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

export function HolderMapPage({
  map,
  list,
  onRefocus,
  onDay,
  showOffList,
  onShowOffList,
}: HolderMapPageProps) {
  const shown = map.day ?? map.refused
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 py-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold tracking-tight">
            Holder map
          </h1>
          {map.refused === undefined && (
            <p className="text-[13px] text-muted-foreground">
              {Effect.runSync(datesLine(map.day, map.month))}
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {shown !== undefined && (
            <DayPicker days={map.days} day={shown} onDay={onDay} />
          )}
          <FocusPicker
            state={list}
            className="w-full sm:w-80"
            onPick={(match) => onRefocus(Effect.runSync(refocusOf(match)))}
          />
        </div>
      </header>
      {map.refused !== undefined ? (
        <Refused day={map.refused} />
      ) : map.focus === undefined ? (
        <MostHeld map={map} />
      ) : (
        <Focus
          focus={map.focus}
          day={map.day}
          month={map.month}
          onRefocus={onRefocus}
          showOffList={showOffList}
          onShowOffList={onShowOffList}
        />
      )}
    </div>
  )
}

// A day asked for in the URL that has no above-5% report.
function Refused({ day }: { day: WibDate }) {
  return (
    <section className={kCard}>
      <KEmptyState
        bare
        kind="no-data"
        title={`No above-5% report on ${Effect.runSync(dayDateLabel(day))}`}
        description="IDX publishes the above-5% report on trading days only, and the map is drawn as of one. Pick a day from the list."
      />
    </section>
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
          {map.day === undefined
            ? "No above-1% report is parsed yet."
            : `No above-1% report is parsed on or before ${Effect.runSync(dayDateLabel(map.day))}.`}{" "}
          Search a stock to start.
        </p>
      ) : (
        <ol aria-label="Most held stocks" className="flex flex-col">
          {map.mostHeld.map(({ code, issuerName, holders }) => (
            <li key={code} className="border-b border-border last:border-0">
              <RefocusLink
                to={{ stock: code }}
                className="flex items-baseline gap-3 py-1.5 text-[13px] hover:bg-muted/50 hover:no-underline"
              >
                <span className="w-14 font-semibold">{code}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {issuerName}
                </span>
                <span className="num">
                  {Effect.runSync(count(holders, "holder", "holders"))}
                </span>
              </RefocusLink>
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
  month,
  onRefocus,
  showOffList,
  onShowOffList,
}: {
  focus: FocusView
  day: WibDate | undefined
  month: WibDate | undefined
  onRefocus: (refocus: Refocus) => void
  showOffList: boolean
  onShowOffList: (shown: boolean) => void
}) {
  const empty =
    focus.kind === "custodian"
      ? focus.book.holders.length === 0
      : focus.bands.every(({ holders }) => holders.length === 0)
  const nothing = Effect.runSync(emptyText(focus, day))
  return (
    <section
      aria-labelledby="holder-map-focus"
      className={cn(kCard, "flex flex-col gap-4")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="holder-map-focus" className="text-[17px] font-semibold">
          {focus.title}{" "}
          <span className="font-medium text-muted-foreground">
            {Effect.runSync(kindLabel(focus))}
          </span>
        </h2>
        {focus.kind === "stock" && (
          <Link
            to="/stocks/$code"
            params={{ code: focus.code }}
            className={cn("text-info text-[13px]", kFocus)}
          >
            Open stock page
          </Link>
        )}
      </div>
      {day !== undefined && month === undefined && (
        <p role="note" className="text-[13px] text-muted-foreground">
          {`No above-1% report is parsed on or before ${Effect.runSync(dayDateLabel(day))}, so the map shows the 5% band only.`}
        </p>
      )}
      {empty ? (
        <KEmptyState
          bare
          kind="no-data"
          title={nothing.title}
          description={nothing.description}
        />
      ) : (
        <>
          <HolderMapGraph
            focus={focus}
            showOffList={showOffList}
            onRefocus={onRefocus}
          />
          {focus.bands.map((band) => (
            <Band key={band.band} band={band} day={day} focus={focus} />
          ))}
          {focus.kind !== "custodian" && (
            <Beyond holdings={focus.beyond} focus={focus.kind} />
          )}
          {focus.kind === "custodian" && <Book book={focus.book} />}
          <Custodians custodians={focus.custodians} focus={focus.kind} />
        </>
      )}
      <OffList
        focus={focus}
        holders={focus.offList}
        shown={showOffList}
        onShown={onShowOffList}
      />
    </section>
  )
}

const TABLE =
  "w-full text-[13px] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_tr]:border-b [&_tr]:border-border"

// A table's header row: each column's name, the first left, the rest right.
function Head({ columns }: { columns: ReadonlyArray<string> }) {
  return (
    <thead className="[&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
      <tr>
        {columns.map((column, at) => (
          <th
            key={column}
            scope="col"
            className={at === 0 ? "text-left" : "text-right"}
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  )
}

// A custodian focus's book: the holders it holds for, each with its stocks
// through it, then those stocks, each with the shares held through it.
function Book({ book }: { book: CustodianBook }) {
  return (
    <>
      <section aria-labelledby="book-holders" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="book-holders" className="text-[15px] font-semibold">
            Holders through it
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {Effect.runSync(count(book.holders.length, "holder", "holders"))}{" "}
            above 5%
          </p>
        </div>
        <div className="overflow-x-auto">
          <table aria-label="Holders through it" className={TABLE}>
            <Head columns={["Holder", "Stocks", "Lots through it"]} />
            <tbody>
              {/* Decision: a page renders a list of stored rows through BoundedRows
                  (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
              <BoundedRows rows={book.holders}>
                {(holder) => (
                  <tr key={holder.key}>
                    <th scope="row" className="text-left font-medium">
                      <RefocusLink to={{ holder: holder.key }}>
                        {holder.name}
                      </RefocusLink>
                    </th>
                    <td className="text-right">
                      <span className="flex flex-wrap justify-end gap-x-2">
                        {holder.stocks.map((code) => (
                          <RefocusLink key={code} to={{ stock: code }}>
                            {code}
                          </RefocusLink>
                        ))}
                      </span>
                    </td>
                    <td className="num text-right whitespace-nowrap">
                      {Effect.runSync(lotsOfShares(holder.shares))}
                    </td>
                  </tr>
                )}
              </BoundedRows>
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="book-stocks" className="flex flex-col gap-2">
        <h3 id="book-stocks" className="text-[15px] font-semibold">
          Stocks through it
        </h3>
        <div className="overflow-x-auto">
          <table aria-label="Stocks through it" className={TABLE}>
            <Head columns={["Stock", "Holders", "Lots through it"]} />
            <tbody>
              {/* Decision: a page renders a list of stored rows through BoundedRows
                  (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
              <BoundedRows rows={book.stocks}>
                {(stock) => (
                  <tr key={stock.code}>
                    <th scope="row" className="text-left font-normal">
                      <div className="font-medium">
                        <RefocusLink to={{ stock: stock.code }}>
                          {stock.code}
                        </RefocusLink>
                      </div>
                      <div className="mt-0.5 text-[12px] text-muted-foreground">
                        {stock.issuerName ?? "Issuer unknown"}
                      </div>
                    </th>
                    <td className="num text-right">{stock.holders}</td>
                    <td className="num text-right whitespace-nowrap">
                      {Effect.runSync(lotsOfShares(stock.shares))}
                    </td>
                  </tr>
                )}
              </BoundedRows>
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// The custodians the map draws, each a link refocusing the map on it.
function Custodians({
  custodians,
  focus,
}: {
  custodians: ReadonlyArray<MapCustodian>
  focus: FocusView["kind"]
}) {
  if (custodians.length === 0) return null
  const title = focus === "custodian" ? "Other custodians" : "Custodians"
  return (
    <section aria-labelledby="custodians" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="custodians" className="text-[15px] font-semibold">
          {title}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          Of the above-5% holders' securities accounts
        </p>
      </div>
      <div className="overflow-x-auto">
        <table aria-label={title} className={TABLE}>
          <Head columns={["Custodian", "Holders", "Lots"]} />
          <tbody>
            {/* Decision: a page renders a list of stored rows through BoundedRows
                (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
            <BoundedRows rows={custodians}>
              {(custodian) => (
                <tr key={custodian.id}>
                  <th scope="row" className="text-left font-normal">
                    <div className="font-medium">
                      <RefocusLink to={{ custodian: custodian.id }}>
                        {custodian.name}
                      </RefocusLink>
                    </div>
                    <div className="mt-0.5 text-[12px] text-muted-foreground">
                      {custodian.broker ?? "No broker code"}
                    </div>
                  </th>
                  <td className="num text-right">{custodian.holders}</td>
                  <td className="num text-right whitespace-nowrap">
                    {Effect.runSync(lotsOfShares(custodian.shares))}
                  </td>
                </tr>
              )}
            </BoundedRows>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Band({
  band,
  day,
  focus,
}: {
  band: BandSection
  day: WibDate | undefined
  focus: FocusView
}) {
  const title = BAND_TITLE[band.band]
  const noun = focus.kind === "stock" ? "holder" : "stock"
  const id = `band-${band.band === "5%" ? "5" : "1"}`
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={id} className="text-[15px] font-semibold">
          {title}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {Effect.runSync(count(band.holders.length, noun, `${noun}s`))} ·{" "}
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
          No {noun} in this band.
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
                  {focus.kind === "stock" ? "Holder" : "Stock"}
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
                  <HolderRow
                    key={`${holder.code} ${holder.holder}`}
                    holder={holder}
                    day={day}
                    focus={focus.kind}
                  />
                )}
              </BoundedRows>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// What the hop beyond lists, by focus: its holders' other stocks, or its
// stocks' other holders, each row the first-hop holding it hangs off and
// the far end.
const BEYOND = {
  stock: {
    title: "Its holders' other stocks",
    columns: ["Holder", "Stock", "Move", "% of listed"],
  },
  holder: {
    title: "Its stocks' other holders",
    columns: ["Stock", "Holder", "Move", "% of listed"],
  },
} as const

// The hop beyond the first, so every node the map draws has a row: each
// end a link refocusing the map on it.
function Beyond({
  holdings,
  focus,
}: {
  holdings: ReadonlyArray<MapHolder>
  focus: "stock" | "holder"
}) {
  if (holdings.length === 0) return null
  const { title, columns } = BEYOND[focus]
  const holderCell = (holding: MapHolder) => (
    <RefocusLink to={{ holder: holding.holder }}>{holding.name}</RefocusLink>
  )
  const stockCell = (holding: MapHolder) => (
    <>
      <RefocusLink to={{ stock: holding.code }}>{holding.code}</RefocusLink>
      <div className="mt-0.5 text-[12px] font-normal text-muted-foreground">
        {holding.issuerName ?? "Issuer unknown"}
      </div>
    </>
  )
  const [near, far] =
    focus === "stock" ? [holderCell, stockCell] : [stockCell, holderCell]
  return (
    <section aria-labelledby="beyond" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="beyond" className="text-[15px] font-semibold">
          {title}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          A hop beyond the bands
        </p>
      </div>
      <div className="overflow-x-auto">
        <table aria-label={title} className={TABLE}>
          <Head columns={columns} />
          <tbody>
            {/* Decision: a page renders a list of stored rows through BoundedRows
                (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
            <BoundedRows rows={holdings}>
              {(holding) => (
                <tr key={`${holding.code} ${holding.holder}`}>
                  <th scope="row" className="text-left font-medium">
                    {near(holding)}
                  </th>
                  <td className="text-left font-medium">{far(holding)}</td>
                  <td className="text-left">
                    <ShownMoveCell holder={holding} />
                  </td>
                  <td className="num text-right whitespace-nowrap">
                    {Effect.runSync(percentOf(holding.percentageHundredths))}
                  </td>
                </tr>
              )}
            </BoundedRows>
          </tbody>
        </table>
      </div>
    </section>
  )
}

// A holding's row: a stock focus's holder, or a holder focus's stock,
// each a link refocusing the map on it.
function HolderRow({
  holder,
  day,
  focus,
}: {
  holder: MapHolder
  day: WibDate | undefined
  focus: FocusView["kind"]
}) {
  const meta =
    focus === "stock"
      ? [
          holder.origin === undefined
            ? "Origin unknown"
            : ORIGIN_LABEL[holder.origin],
          holder.investorType === undefined
            ? "Type unknown"
            : KSEI_TYPE_LABELS[holder.investorType],
        ]
      : [holder.issuerName ?? "Issuer unknown"]
  return (
    <tr>
      <th scope="row" className="text-left font-normal">
        <div className="font-medium">
          {focus === "stock" ? (
            <RefocusLink to={{ holder: holder.holder }}>
              {holder.name}
            </RefocusLink>
          ) : (
            <RefocusLink to={{ stock: holder.code }}>{holder.code}</RefocusLink>
          )}
        </div>
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

// The focus's earlier holdings, each with the period it left its list,
// hidden by the toggle.
function OffList({
  focus,
  holders,
  shown,
  onShown,
}: {
  focus: FocusView
  holders: ReadonlyArray<HolderMapOffList>
  shown: boolean
  onShown: (shown: boolean) => void
}) {
  if (holders.length === 0) return null
  return (
    <section aria-labelledby="off-list" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="off-list" className="text-[15px] font-semibold">
          Off list
        </h3>
        <KChip
          selected={shown}
          onSelectedChange={onShown}
          count={holders.length}
        >
          Show Off list
        </KChip>
      </div>
      {shown && (
        <ul
          aria-label={
            focus.kind === "stock" ? "Off list holders" : "Off list stocks"
          }
          className="flex flex-col text-[13px]"
        >
          {/* Decision: a page renders a list of stored rows through BoundedRows
              (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
          <BoundedRows rows={holders}>
            {(holder) => (
              <OffListRow
                key={`${holder.code} ${holder.holder}`}
                holder={holder}
                focus={focus.kind}
              />
            )}
          </BoundedRows>
        </ul>
      )}
    </section>
  )
}

function OffListRow({
  holder,
  focus,
}: {
  holder: HolderMapOffList
  focus: FocusView["kind"]
}) {
  const since = Effect.runSync(periodLabel(holder.band, holder.since))
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-1.5 text-muted-foreground opacity-80 last:border-0">
      <span className="font-medium">
        {focus === "stock" ? (
          <RefocusLink to={{ holder: holder.holder }}>
            {holder.name}
          </RefocusLink>
        ) : (
          <RefocusLink to={{ stock: holder.code }}>{holder.code}</RefocusLink>
        )}
      </span>
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
