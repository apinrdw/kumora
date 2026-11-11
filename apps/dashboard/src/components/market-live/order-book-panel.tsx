import type { BookLevel, OrderBook } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, DateTime } from "effect"
import { useSyncExternalStore } from "react"

import { compact, plain, tapeTime } from "@/lib/format"

import { StaleSince, useMergedStale } from "./market-conditions"
import type { OrderBookStore } from "./order-book-store"

// The ladder shows 10 levels a side; the depth curve draws 20 (spec
// apinrdw/kumora#138, "Order book").
const LADDER_LEVELS = 10

const PROVENANCE = { Stockbit: "Stockbit", Ajaib: "Ajaib (fallback)" } as const

const priceTone = (price: number, previousClose: number | undefined) =>
  Effect.sync(() =>
    previousClose === undefined || price === previousClose
      ? "text-neutral"
      : price > previousClose
        ? "text-up"
        : "text-down"
  )

// A lot figure with its bar behind it, scaled to the largest level shown:
// bids grow from the right edge, offers from the left.
const lotBar = (level: BookLevel, largest: number, side: "bid" | "offer") =>
  Effect.sync(() => ({
    background: `linear-gradient(to ${side === "bid" ? "left" : "right"}, color-mix(in oklab, var(--semantic-${side === "bid" ? "up" : "down"}) 18%, transparent) ${(level.lots / largest) * 100}%, transparent 0)`,
  }))

const DEPTH_WIDTH = 360
const DEPTH_HEIGHT = 64

const cumulative = (levels: ReadonlyArray<BookLevel>) =>
  Effect.sync(() => {
    let lots = 0
    return levels.map((level) => ({
      price: level.price,
      lots: (lots += level.lots),
    }))
  })

// The order book curve's two SVG areas, bids and offers, on one price and lot scale.
const curveAreas = Effect.fnUntraced(function* (book: OrderBook) {
  const bids = yield* cumulative(book.bids)
  const offers = yield* cumulative(book.offers)
  const low = bids.at(-1)?.price ?? offers[0]?.price ?? 0
  const high = offers.at(-1)?.price ?? bids[0]?.price ?? 0
  const most = Math.max(bids.at(-1)?.lots ?? 0, offers.at(-1)?.lots ?? 0, 1)
  const x = (price: number) => ((price - low) / (high - low || 1)) * DEPTH_WIDTH
  const y = (lots: number) => DEPTH_HEIGHT - (lots / most) * (DEPTH_HEIGHT - 4)
  const area = (points: ReadonlyArray<{ price: number; lots: number }>) =>
    points.length === 0
      ? ""
      : `M${x(points[0]!.price)},${DEPTH_HEIGHT} ${points
          .map((point) => `L${x(point.price)},${y(point.lots)}`)
          .join(" ")} L${x(points.at(-1)!.price)},${DEPTH_HEIGHT} Z`
  return { bids: area(bids), offers: area(offers) }
})

// Cumulative lots over price: bids green from the left, offers red to the
// right, over the 20 levels a side the book carries.
function DepthCurve({ book }: { book: OrderBook }) {
  const areas = Effect.runSync(curveAreas(book))
  return (
    <svg
      viewBox={`0 0 ${DEPTH_WIDTH} ${DEPTH_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Cumulative depth, 20 levels a side"
      className="h-16 w-full"
    >
      <path
        d={areas.bids}
        fill="color-mix(in oklab, var(--semantic-up) 25%, transparent)"
        stroke="var(--semantic-up)"
      />
      <path
        d={areas.offers}
        fill="color-mix(in oklab, var(--semantic-down) 25%, transparent)"
        stroke="var(--semantic-down)"
      />
    </svg>
  )
}

// Bid and offer lots across the whole book, and the bids' share.
function Totals({ book }: { book: OrderBook }) {
  const total = book.bidLots + book.offerLots
  const bidShare = total === 0 ? 50 : (book.bidLots / total) * 100
  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <div className="flex justify-between tabular-nums">
        <span>
          Bid <b className="text-up">{Effect.runSync(compact(book.bidLots))}</b>{" "}
          lots · {Effect.runSync(plain(bidShare))}%
        </span>
        <span>
          Offer{" "}
          <b className="text-down">{Effect.runSync(compact(book.offerLots))}</b>{" "}
          lots
        </span>
      </div>
      <div
        role="meter"
        aria-label="Bid share"
        aria-valuenow={Math.round(bidShare)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="flex h-1.5 overflow-hidden rounded-full"
      >
        <i className="bg-up" style={{ width: `${bidShare}%` }} />
        <i className="bg-down flex-1" />
      </div>
    </div>
  )
}

function Ladder({ book }: { book: OrderBook }) {
  const rows = Array.from(
    { length: LADDER_LEVELS },
    (_, index) => [book.bids[index], book.offers[index]] as const
  )
  const largest = Math.max(
    1,
    ...rows.flatMap(([bid, offer]) => [bid?.lots ?? 0, offer?.lots ?? 0])
  )
  const tone = (level: BookLevel | undefined) =>
    level && Effect.runSync(priceTone(level.price, book.previousClose))
  return (
    <table className="w-full text-[12px] tabular-nums">
      <thead className="text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
        <tr className="h-6">
          <th className="pl-1 text-right font-medium">Freq</th>
          <th className="text-right font-medium">Lot</th>
          <th className="pr-2 text-right font-medium">Bid</th>
          <th className="pl-2 text-left font-medium">Offer</th>
          <th className="text-left font-medium">Lot</th>
          <th className="pr-1 text-left font-medium">Freq</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([bid, offer], index) => (
          <tr key={index} className="h-[22px]">
            <td className="pl-1 text-right text-muted-foreground">
              {bid && Effect.runSync(plain(bid.orders))}
            </td>
            <td
              className="text-right"
              style={bid && Effect.runSync(lotBar(bid, largest, "bid"))}
            >
              {bid && Effect.runSync(plain(bid.lots))}
            </td>
            <td
              className={cn(
                "pr-2 text-right font-semibold",
                tone(bid),
                index === 0 && "underline decoration-dotted"
              )}
            >
              {bid && Effect.runSync(plain(bid.price))}
            </td>
            <td
              className={cn(
                "pl-2 font-semibold",
                tone(offer),
                index === 0 && "underline decoration-dotted"
              )}
            >
              {offer && Effect.runSync(plain(offer.price))}
            </td>
            <td
              style={offer && Effect.runSync(lotBar(offer, largest, "offer"))}
            >
              {offer && Effect.runSync(plain(offer.lots))}
            </td>
            <td className="pr-1 text-muted-foreground">
              {offer && Effect.runSync(plain(offer.orders))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// The selected code's order book as an IDX ladder, live from the viewer
// socket through `store`, with its depth curve and totals underneath. On a
// recorded day, `recorded`: the stored frame in force, headed by its time,
// and `notRecorded` inside a relay gap.
export function OrderBookPanel({
  store,
  recorded = false,
  notRecorded = false,
}: {
  store: OrderBookStore
  recorded?: boolean
  notRecorded?: boolean
}) {
  const book = useSyncExternalStore(
    store.subscribe,
    store.book,
    () => undefined
  )
  // Both feeds down: the last good book stays, dimmed under a warning border.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Order book"
      data-stale={stale || undefined}
      className={cn(
        "flex flex-col gap-2",
        stale && "border-warning rounded-md border p-2"
      )}
    >
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Order book</h2>
        <span className="text-sm font-bold">{store.code}</span>
        {stale && book?._tag === "OrderBook" && <StaleSince at={book.at} />}
        {recorded && !notRecorded && book?._tag === "OrderBook" && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Recorded frame ·{" "}
            {Effect.runSync(tapeTime(DateTime.toEpochMillis(book.at)))}
          </span>
        )}
        {!recorded && book?._tag === "OrderBook" && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            <i
              className={cn(
                "size-1.5 rounded-full",
                book.provenance === "Stockbit" ? "bg-info" : "bg-warning"
              )}
            />
            {PROVENANCE[book.provenance]}
          </span>
        )}
      </header>
      {notRecorded ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          Not recorded
        </p>
      ) : book === undefined ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          No data yet.
        </p>
      ) : book._tag === "IndexHasNoBook" ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          Indices have no order book.
        </p>
      ) : (
        <div className={cn("flex flex-col gap-2", stale && "opacity-60")}>
          <Ladder book={book} />
          <DepthCurve book={book} />
          <Totals book={book} />
        </div>
      )}
    </section>
  )
}
