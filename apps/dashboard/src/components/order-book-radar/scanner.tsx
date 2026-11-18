// The order book radar's scanner (spec apinrdw/kumora#517, "The scanner"),
// layout D: the Bid-heavy and Offer-heavy halves, each row unfolding its
// best 5 levels, the codes at a limit under them, each row with its last
// book event's chip.
import type { BookLevel, StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { IconStarFilled } from "@tabler/icons-react"
import { DateTime, Effect } from "effect"
import { useSyncExternalStore } from "react"

import { KButton } from "@/components/k/button"
import type { BookReadingsStore } from "@/components/market-live/book-readings-store"
import type { OrderBookStore } from "@/components/market-live/order-book-store"
import {
  BOOK_EVENT_MARKS,
  BOOK_EVENT_NAMES,
  bookEventDetail,
} from "@/lib/book-events"
import { lots, price, signed } from "@/lib/format"
import {
  isStale,
  rankedFigure,
  RECENT_EVENTS_MS,
  type CodeEvents,
  type RankKey,
  type Scan,
} from "@/lib/order-book-radar"

const NEAR_LEVELS = 5

type Half = "bid" | "offer"

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

const lotsText = (n: number) => Effect.runSync(lots(n))

// The row's last book event of the last 5 minutes: its mark coloured by
// side, its name and detail on hover.
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
    <span aria-label="Last event" className="text-right">
      {recent && (
        <abbr
          title={`${BOOK_EVENT_NAMES[event.kind]}: ${Effect.runSync(bookEventDetail(event))}`}
          className={cn(
            "rounded-xs px-0.5 text-[9px] font-bold no-underline sm:px-1 sm:text-[10px]",
            event.side === "bid" ? "bg-up/15 text-up" : "bg-down/15 text-down"
          )}
        >
          {BOOK_EVENT_MARKS[event.kind]}
        </abbr>
      )}
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
          <span className="relative text-right">{lotsText(level.lots)}</span>
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

function Row({
  code,
  half,
  view,
}: {
  code: StockCode
  half: Half
  view: RowView
}) {
  const readings = view.readings.readingsOf(code)
  if (readings === undefined) return null
  const imbalance = readings.imbalance ?? 0
  const stale = isStale(readings, view.marketNow)
  const unfolded = view.unfolded === code
  const events = view.events.get(code)
  return (
    <li
      data-code={code}
      data-stale={stale || undefined}
      className={cn("border-b border-border", stale && "opacity-50")}
    >
      <button
        type="button"
        aria-expanded={unfolded}
        onClick={() => view.onUnfold(unfolded ? undefined : code)}
        className="hover:bg-elevated grid w-full grid-cols-[88px_1fr_48px_16px] items-center gap-2 px-2.5 py-1.5 text-left text-[12px] sm:grid-cols-[96px_1fr_52px_100px_64px]"
      >
        <span className="flex items-center gap-1 font-bold tracking-[0.02em]">
          {code}
          {view.watchlist.has(code) && (
            <IconStarFilled
              aria-label="On the watchlist"
              className="size-3 text-primary"
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
        <span
          aria-label="Ranked by"
          className="hidden text-right text-muted-foreground tabular-nums sm:block"
        >
          {Effect.runSync(
            rankedFigure(readings, view.rankBy, view.marketNow, events)
          )}
        </span>
        <LastEvent events={events} now={view.marketNow} />
      </button>
      {unfolded && (
        <Unfolded code={code} book={view.book} onOpen={view.onOpen} />
      )}
    </li>
  )
}

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
                <Row key={code} code={code} half={half} view={view} />
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
