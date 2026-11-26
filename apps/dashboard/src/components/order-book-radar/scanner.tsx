// The order book radar's scanner (spec apinrdw/kumora#517, "The scanner"),
// layout D: the Bid-heavy and Offer-heavy halves, each row unfolding its
// best 5 levels, the codes at a limit under them, each row with its last
// book or order flow event's chip.
import {
  heavySideOf,
  type BookEventSide,
  type BookLevel,
  type BookReadings,
  type StockCode,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { IconStarFilled } from "@tabler/icons-react"
import { DateTime, Effect } from "effect"
import { memo, useSyncExternalStore } from "react"

import { KButton } from "@/components/k/button"
import type { BookReadingsStore } from "@/components/market-live/book-readings-store"
import { HeavySideChip } from "@/components/market-live/heavy-side-chip"
import type { OrderBookStore } from "@/components/market-live/order-book-store"
import { EventChip } from "@/components/market-live/event-mark"
import { lots, price, signed, wibClock } from "@/lib/format"
import {
  isStale,
  rankedFigure,
  RECENT_EVENTS_MS,
  type CodeEvents,
  type RankKey,
  type Scan,
} from "@/lib/order-book-radar"

const NEAR_LEVELS = 5

// A scanner half: the codes whose imbalance leans to that book side.
type Half = BookEventSide

const HALVES: ReadonlyArray<{
  readonly half: Half
  readonly title: string
  readonly tone: string
}> = [
  { half: "bid", title: "Bid-heavy", tone: "text-up" },
  { half: "offer", title: "Offer-heavy", tone: "text-down" },
]

export interface RowView {
  readonly readings: BookReadingsStore
  readonly rankBy: RankKey
  readonly marketNow: number
  readonly watchlist: ReadonlySet<StockCode>
  // Each code's book events, as of marketNow.
  readonly events: ReadonlyMap<StockCode, CodeEvents>
  readonly unfolded: StockCode | undefined
  readonly onUnfold: (code: StockCode | undefined) => void
  readonly book: OrderBookStore | undefined
  readonly onOpen: (code: StockCode) => void
}

// The diverging bar, sized by |imbalance|: growing right from the left
// edge in the Bid-heavy half, left from the right edge in the Offer-heavy.
function TugBar({ imbalance, half }: { imbalance: number; half: Half }) {
  return (
    <span className="relative h-3.5 overflow-hidden rounded-xs bg-background">
      <i
        className={cn(
          "absolute inset-y-0",
          half === "bid" ? "bg-up left-0" : "bg-down right-0"
        )}
        style={{ width: `${Math.min(100, Math.abs(imbalance) * 100)}%` }}
      />
    </span>
  )
}

// The row's last event of the last 5 minutes, book or order flow: its
// mark, and from 640 px its minute; its name and detail on hover.
function LastEvent({
  events,
  now,
}: {
  events: CodeEvents | undefined
  now: number
}) {
  const event = events?.last
  const recent =
    event !== undefined &&
    now - DateTime.toEpochMillis(event.at) < RECENT_EVENTS_MS
  return (
    <span aria-label="Last event" className="text-right whitespace-nowrap">
      {recent && (
        <>
          <EventChip event={event} />
          <span className="ml-1 hidden text-[10px] text-muted-foreground sm:inline">
            {Effect.runSync(wibClock(DateTime.toEpochMillis(event.at)))}
          </span>
        </>
      )}
    </span>
  )
}

// The row's heavy side chip, if any. The halves hold no code at a limit
// (`scan`).
function HeavySideCell({ readings }: { readings: BookReadings }) {
  const heavy = Effect.runSync(heavySideOf(readings, undefined))
  return (
    <span className="flex justify-start">
      {heavy !== undefined && <HeavySideChip heavy={heavy} />}
    </span>
  )
}

// One side's best levels: price, lots and orders over a bar of its lots.
function Levels({
  levels,
  most,
  half,
  label,
}: {
  levels: ReadonlyArray<BookLevel>
  most: number
  half: Half
  label: string
}) {
  return (
    <ol aria-label={label} className="flex flex-col gap-px">
      {levels.map((level) => (
        <li
          key={level.price}
          className="relative grid grid-cols-[1fr_64px_36px] gap-1.5 px-1 tabular-nums"
        >
          <b
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 rounded-xs",
              half === "bid" ? "bg-up/15" : "bg-down/15"
            )}
            style={{ width: `${(level.lots / most) * 100}%` }}
          />
          <span className="relative">{Effect.runSync(price(level.price))}</span>
          <span className="relative text-right">
            {Effect.runSync(lots(level.lots))}
          </span>
          <span className="relative text-right text-muted-foreground">
            {level.orders}
          </span>
        </li>
      ))}
    </ol>
  )
}

// The unfolded row: its best 5 levels a side from the code's whole book,
// which the page selected, and the way to Market Live.
function Unfolded({
  code,
  book,
  onOpen,
}: {
  code: StockCode
  book: OrderBookStore | undefined
  onOpen: (code: StockCode) => void
}) {
  const held = useSyncExternalStore(
    (listener) => book?.subscribe(listener) ?? (() => undefined),
    () => book?.book(),
    () => undefined
  )
  const levels =
    held?._tag === "OrderBook"
      ? {
          bids: held.bids.slice(0, NEAR_LEVELS),
          offers: held.offers.slice(0, NEAR_LEVELS),
        }
      : undefined
  const most = Math.max(
    1,
    ...(levels?.bids ?? []).map((level) => level.lots),
    ...(levels?.offers ?? []).map((level) => level.lots)
  )
  return (
    <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2 text-[12px]">
      {levels === undefined ? (
        <p className="text-muted-foreground">Loading the book…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Levels
            levels={levels.bids}
            most={most}
            half="bid"
            label={`${code} best bids`}
          />
          <Levels
            levels={levels.offers}
            most={most}
            half="offer"
            label={`${code} best offers`}
          />
        </div>
      )}
      <KButton
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => onOpen(code)}
      >
        Open {code} in Market Live
      </KButton>
    </div>
  )
}

interface RowProps {
  readonly code: StockCode
  readonly half: Half
  readonly readings: BookReadingsStore
  readonly rankBy: RankKey
  readonly marketNow: number
  readonly watched: boolean
  readonly events: CodeEvents | undefined
  readonly unfolded: boolean
  readonly onUnfold: (code: StockCode | undefined) => void
  // The selected code's book, for the unfolded row only.
  readonly book: OrderBookStore | undefined
  readonly onOpen: (code: StockCode) => void
}

// A row selects its own code's readings, so a delta re-renders only the
// rows whose codes it carries; the memo skips the rest when the page
// re-renders.
const Row = memo(function Row({
  code,
  half,
  readings: store,
  rankBy,
  marketNow,
  watched,
  events,
  unfolded,
  onUnfold,
  book,
  onOpen,
}: RowProps) {
  const readings = useSyncExternalStore(
    store.subscribe,
    () => store.readingsOf(code),
    () => undefined
  )
  if (readings === undefined) return null
  const imbalance = readings.imbalance ?? 0
  const stale = Effect.runSync(isStale(readings, marketNow))
  return (
    <li
      data-code={code}
      data-stale={stale || undefined}
      className={cn("border-b border-border", stale && "opacity-50")}
    >
      <button
        type="button"
        aria-expanded={unfolded}
        onClick={() => onUnfold(unfolded ? undefined : code)}
        className="hover:bg-elevated grid w-full grid-cols-[72px_1fr_44px_78px_16px] items-center gap-2 px-2.5 py-1.5 text-left text-[12px] sm:grid-cols-[96px_1fr_52px_78px_100px_64px]"
      >
        {/* A code too long for its column truncates; the star never
            shrinks away beside it. */}
        <span className="flex min-w-0 items-center gap-1 font-bold tracking-[0.02em]">
          <span className="truncate">{code}</span>
          {watched && (
            <IconStarFilled
              aria-label="On the watchlist"
              className="size-3 shrink-0 text-primary"
            />
          )}
        </span>
        <TugBar imbalance={imbalance} half={half} />
        <span
          aria-label="Imbalance"
          className={cn(
            "text-right tabular-nums",
            half === "bid" ? "text-up" : "text-down"
          )}
        >
          {Effect.runSync(signed(imbalance * 100, 0))}%
        </span>
        <HeavySideCell readings={readings} />
        <span
          aria-label="Ranked by"
          className="hidden text-right text-muted-foreground tabular-nums sm:block"
        >
          {Effect.runSync(rankedFigure(readings, rankBy, marketNow, events))}
        </span>
        <LastEvent events={events} now={marketNow} />
      </button>
      {unfolded && <Unfolded code={code} book={book} onOpen={onOpen} />}
    </li>
  )
})

// The two halves, side by side, stacked on a phone; the order holds while
// the pointer is over them.
export function Halves({
  scan,
  view,
  onHover,
}: {
  scan: Scan
  view: RowView
  onHover: (hovering: boolean) => void
}) {
  return (
    <div
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      className="flex min-w-0 flex-col gap-2.5"
    >
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        {HALVES.map(({ half, title, tone }) => (
          <section
            key={half}
            aria-label={title}
            className="bg-surface min-w-0 rounded-md border border-border"
          >
            <h2 className="flex justify-between border-b border-border px-2.5 py-2 text-[13px] font-semibold">
              <span className={tone}>{title}</span>
              <span className="font-normal text-muted-foreground">
                {scan[half].length} codes
              </span>
            </h2>
            <ol aria-label={`${title} codes`}>
              {scan[half].map((code) => (
                <Row
                  key={code}
                  code={code}
                  half={half}
                  readings={view.readings}
                  rankBy={view.rankBy}
                  marketNow={view.marketNow}
                  watched={view.watchlist.has(code)}
                  events={view.events.get(code)}
                  unfolded={view.unfolded === code}
                  onUnfold={view.onUnfold}
                  book={view.unfolded === code ? view.book : undefined}
                  onOpen={view.onOpen}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
      {scan.limits.length > 0 && (
        <p className="text-center text-[12px] text-muted-foreground">
          At a limit, not ranked:{" "}
          {scan.limits.map(({ code, limit }, index) => (
            <span key={code}>
              {index > 0 && ", "}
              <b className="text-foreground">{code}</b> ({limit})
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
