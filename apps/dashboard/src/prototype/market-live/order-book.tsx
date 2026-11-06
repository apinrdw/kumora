// PROTOTYPE, throwaway: three order book panels for the selected stock code, on a fake Stockbit v1 book
// with the Ajaib fallback. Mounted under the Watchlist in layout E (variants F, G, H).
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useState } from "react"

import { plain } from "@/lib/format"
import { FEED, STOCKS } from "./fake-feed"

type Level = { price: number; lots: number; orders: number }
type Book = {
  code: string
  bid: ReadonlyArray<Level>
  offer: ReadonlyArray<Level>
  /** Where the book came from: Stockbit v1, or Ajaib when Stockbit is stale. */
  source: "stockbit" | "ajaib" | "stale"
  asOf: number
  ara: number
  arb: number
  last: number
  prevClose: number
}

/** IDX price fractions. */
function tick(price: number): number {
  if (price < 200) return 1
  if (price < 500) return 2
  if (price < 2000) return 5
  if (price < 5000) return 10
  return 25
}

/** Auto-reject limits off the previous close (symmetric bands, approximate). */
function limits(prev: number): { ara: number; arb: number } {
  const pct = prev <= 200 ? 0.35 : prev <= 5000 ? 0.25 : 0.2
  const t = tick(prev)
  return {
    ara: Math.floor((prev * (1 + pct)) / t) * t,
    arb: Math.ceil((prev * (1 - pct)) / t) * t,
  }
}

function fakeBook(code: string): Book {
  const stock = STOCKS.find((s) => s.code === code) ?? STOCKS[0]!
  const last = FEED.last(code)
  const { ara, arb } = limits(stock.prevClose)
  const t = tick(last)
  const side = (dir: 1 | -1): Array<Level> => {
    const out: Array<Level> = []
    // Best bid at last, best offer one tick up; depth runs to the limit, like Stockbit's v1 frames.
    for (
      let p = dir === 1 ? last + t : last;
      dir === 1 ? p <= ara : p >= arb;
      p += dir * tick(p)
    ) {
      const dist = out.length
      const base = dist < 3 ? 4_000 : dist < 10 ? 1_500 : 300
      out.push({
        price: p,
        lots: Math.ceil(base * (0.3 + Math.random() * 1.4)),
        orders: Math.ceil(5 + Math.random() * (dist < 5 ? 120 : 30)),
      })
      if (out.length >= 80) break
    }
    return out
  }
  const sb = FEED.state.stockbit === "live"
  const aj = FEED.state.ajaib === "live"
  return {
    code,
    bid: side(-1),
    offer: side(1),
    source: sb ? "stockbit" : aj ? "ajaib" : "stale",
    asOf: Date.now(),
    ara,
    arb,
    last,
    prevClose: stock.prevClose,
  }
}

/** ~2.5 frames/s like Stockbit v1; frozen when both feeds are stale. */
function useBook(code: string): Book {
  const [book, setBook] = useState(() => fakeBook(code))
  useEffect(() => {
    const id = setInterval(() => {
      setBook((b) => {
        const next = fakeBook(code)
        return next.source === "stale" ? { ...b, source: "stale" } : next
      })
    }, 400)
    return () => clearInterval(id)
  }, [code])
  return book
}

function cumulate(levels: ReadonlyArray<Level>) {
  let cum = 0
  return levels.map((l) => ({ ...l, cum: (cum += l.lots) }))
}

const sum = (l: ReadonlyArray<Level>) => l.reduce((s, x) => s + x.lots, 0)

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function priceTone(p: number, prev: number) {
  return p > prev ? "text-up" : p < prev ? "text-down" : "text-neutral"
}

function SourceTag({ book }: { book: Book }) {
  const [now, setNow] = useState(book.asOf)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (book.source === "stale")
    return (
      <span
        className="text-warning text-[11px]"
        title="Both feeds stale; last good book shown."
      >
        STALE · {Math.round((now - book.asOf) / 1000)}s ago
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <i
        className={cn(
          "size-1.5 rounded-full",
          book.source === "stockbit" ? "bg-info" : "bg-warning"
        )}
      />
      {book.source === "stockbit" ? "Stockbit" : "Ajaib (fallback)"}
    </span>
  )
}

function Shell({
  title,
  book,
  className,
  children,
}: {
  title: string
  book: Book
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "bg-surface flex min-h-0 flex-col rounded-lg border border-border",
        book.source === "stale" && "border-warning",
        className
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <b className="text-sm">{book.code}</b>
        <span className="ml-auto">
          <SourceTag book={book} />
        </span>
      </header>
      <div
        className={cn(
          "min-h-0 flex-1",
          book.source === "stale" && "opacity-60"
        )}
      >
        {children}
      </div>
    </section>
  )
}

function BidBar({ book }: { book: Book }) {
  const b = sum(book.bid)
  const o = sum(book.offer)
  const pct = (b / (b + o)) * 100
  return (
    <div className="px-3 py-1.5 text-[11px]">
      <div className="mb-1 flex justify-between text-muted-foreground">
        <span>
          Bid <b className="text-up">{compact(b)}</b> lot · {pct.toFixed(0)}%
        </span>
        <span>
          {(100 - pct).toFixed(0)}% · <b className="text-down">{compact(o)}</b>{" "}
          lot Offer
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full">
        <i className="bg-up" style={{ width: `${pct}%` }} />
        <i className="bg-down flex-1" />
      </div>
    </div>
  )
}

/** Cumulative lots over price, 20 levels a side: bids green from the left, offers red to the right. */
function DepthCurve({ book, className }: { book: Book; className?: string }) {
  const w = 360
  const h = 70
  const curve = (levels: ReadonlyArray<Level>) => {
    let c = 0
    return levels.slice(0, 20).map((l) => ({ p: l.price, c: (c += l.lots) }))
  }
  const bc = curve(book.bid)
  const oc = curve(book.offer)
  const lo = bc.at(-1)?.p ?? book.last
  const hi = oc.at(-1)?.p ?? book.last
  const cmax = Math.max(bc.at(-1)?.c ?? 1, oc.at(-1)?.c ?? 1)
  const x = (p: number) => ((p - lo) / (hi - lo || 1)) * w
  const y = (c: number) => h - (c / cmax) * (h - 4)
  const path = (pts: Array<{ p: number; c: number }>) =>
    `M${x(pts[0]?.p ?? 0)},${h} ` +
    pts.map((q) => `L${x(q.p)},${y(q.c)}`).join(" ") +
    ` L${x(pts.at(-1)?.p ?? 0)},${h} Z`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn("h-[70px]", className)}
      preserveAspectRatio="none"
      aria-label="Cumulative depth, 20 levels a side"
    >
      <path
        d={path(bc)}
        fill="color-mix(in oklab, var(--semantic-up) 25%, transparent)"
        stroke="var(--semantic-up)"
      />
      <path
        d={path(oc)}
        fill="color-mix(in oklab, var(--semantic-down) 25%, transparent)"
        stroke="var(--semantic-down)"
      />
    </svg>
  )
}

// ---------- F: classic IDX ladder (bid and offer side by side, 10 levels) ----------

export function BookLadder({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const book = useBook(code)
  const rows = Array.from(
    { length: 10 },
    (_, i) => [book.bid[i], book.offer[i]] as const
  )
  const max = Math.max(
    ...rows.flatMap(([b, o]) => [b?.lots ?? 0, o?.lots ?? 0])
  )
  return (
    <Shell title="Order book" book={book} className={className}>
      <div className="flex h-full flex-col">
        <table className="num w-full text-[12px]">
          <thead className="text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            <tr className="h-6 text-right">
              <th className="pl-3 font-medium">Freq</th>
              <th className="font-medium">Lot</th>
              <th className="pr-2 font-medium">Bid</th>
              <th className="pl-2 text-left font-medium">Offer</th>
              <th className="text-left font-medium">Lot</th>
              <th className="pr-3 text-left font-medium">Freq</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([b, o], i) => (
              <tr key={i} className="h-[22px]">
                <td className="pl-3 text-right text-muted-foreground">
                  {b ? plain(b.orders) : ""}
                </td>
                <td
                  className="text-right"
                  style={
                    b
                      ? {
                          background: `linear-gradient(to left, color-mix(in oklab, var(--semantic-up) 18%, transparent) ${(b.lots / max) * 100}%, transparent 0)`,
                        }
                      : undefined
                  }
                >
                  {b ? plain(b.lots) : ""}
                </td>
                <td
                  className={cn(
                    "pr-2 text-right font-semibold",
                    b && priceTone(b.price, book.prevClose),
                    i === 0 && "underline decoration-dotted"
                  )}
                >
                  {b ? plain(b.price) : ""}
                </td>
                <td
                  className={cn(
                    "pl-2 font-semibold",
                    o && priceTone(o.price, book.prevClose),
                    i === 0 && "underline decoration-dotted"
                  )}
                >
                  {o ? plain(o.price) : ""}
                </td>
                <td
                  style={
                    o
                      ? {
                          background: `linear-gradient(to right, color-mix(in oklab, var(--semantic-down) 18%, transparent) ${(o.lots / max) * 100}%, transparent 0)`,
                        }
                      : undefined
                  }
                >
                  {o ? plain(o.lots) : ""}
                </td>
                <td className="pr-3 text-muted-foreground">
                  {o ? plain(o.orders) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-auto border-t border-border">
          <DepthCurve book={book} className="mx-3 mt-2" />
          <BidBar book={book} />
          <div className="flex justify-between px-3 pb-1.5 text-[11px] text-muted-foreground">
            <span>
              ARB <b className="text-down">{plain(book.arb)}</b>
            </span>
            <span>
              ARA <b className="text-up">{plain(book.ara)}</b>
            </span>
          </div>
        </div>
      </div>
    </Shell>
  )
}

// ---------- G: one vertical price ladder, full depth to ARA/ARB, cumulative lots ----------

export function BookVertical({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const book = useBook(code)
  const offers = cumulate(book.offer)
  const bids = cumulate(book.bid)
  const max = Math.max(offers.at(-1)?.cum ?? 0, bids.at(-1)?.cum ?? 0)
  const spreadRef = (el: HTMLTableRowElement | null) => {
    // Keep the spread row in view the first time the code is shown.
    if (el && !el.dataset.done) {
      el.scrollIntoView({ block: "center" })
      el.dataset.done = "1"
    }
  }
  const Row = ({
    l,
    side,
  }: {
    l: Level & { cum: number }
    side: "bid" | "offer"
  }) => (
    <tr className="h-[20px] text-right">
      <td className="pl-3 text-muted-foreground">{plain(l.orders)}</td>
      <td>{plain(l.lots)}</td>
      <td
        className={cn(
          "pr-2 font-semibold",
          priceTone(l.price, book.prevClose),
          (l.price === book.ara || l.price === book.arb) && "underline"
        )}
        title={
          l.price === book.ara
            ? "ARA"
            : l.price === book.arb
              ? "ARB"
              : undefined
        }
      >
        {plain(l.price)}
      </td>
      <td
        className="pr-3 text-muted-foreground"
        style={{
          background: `linear-gradient(to left, color-mix(in oklab, var(--semantic-${side === "bid" ? "up" : "down"}) 16%, transparent) ${(l.cum / max) * 100}%, transparent 0)`,
        }}
      >
        {compact(l.cum)}
      </td>
    </tr>
  )
  return (
    <Shell title="Order book" book={book} className={className}>
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="num w-full text-[12px]">
            <thead className="bg-surface sticky top-0 z-10 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
              <tr className="h-6 text-right">
                <th className="pl-3 font-medium">Freq</th>
                <th className="font-medium">Lot</th>
                <th className="pr-2 font-medium">Price</th>
                <th className="pr-3 font-medium">Cum lot</th>
              </tr>
            </thead>
            <tbody>
              {[...offers].reverse().map((l) => (
                <Row key={`o${l.price}`} l={l} side="offer" />
              ))}
              <tr ref={spreadRef} className="bg-elevated h-7 text-right">
                <td
                  colSpan={2}
                  className="pl-3 text-left text-[11px] text-muted-foreground"
                >
                  Last · spread{" "}
                  {plain(
                    (book.offer[0]?.price ?? 0) - (book.bid[0]?.price ?? 0)
                  )}
                </td>
                <td
                  className={cn(
                    "pr-2 text-sm font-bold",
                    priceTone(book.last, book.prevClose)
                  )}
                >
                  {plain(book.last)}
                </td>
                <td className="pr-3 text-[11px] text-muted-foreground">
                  {(
                    ((book.last - book.prevClose) / book.prevClose) *
                    100
                  ).toFixed(2)}
                  %
                </td>
              </tr>
              {bids.map((l) => (
                <Row key={`b${l.price}`} l={l} side="bid" />
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border">
          <BidBar book={book} />
        </div>
      </div>
    </Shell>
  )
}

// ---------- H: summary + depth curve, top 5 levels, expand for full book ----------

export function BookDepth({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const book = useBook(code)
  const [full, setFull] = useState(false)
  const n = full ? 20 : 5
  const bestBid = book.bid[0]
  const bestOffer = book.offer[0]
  return (
    <Shell title="Order book" book={book} className={className}>
      <div className="flex h-full flex-col">
        <div className="grid grid-cols-3 gap-2 px-3 pt-2 text-[11px]">
          <div>
            <div className="text-muted-foreground">Best bid</div>
            <div className="num text-up text-base font-bold">
              {bestBid ? plain(bestBid.price) : "–"}
            </div>
            <div className="num text-muted-foreground">
              {bestBid ? `${plain(bestBid.lots)} lot` : ""}
            </div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground">Spread</div>
            <div className="num text-base font-bold">
              {plain((bestOffer?.price ?? 0) - (bestBid?.price ?? 0))}
            </div>
            <div className="num text-muted-foreground">
              {plain(book.arb)} – {plain(book.ara)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Best offer</div>
            <div className="num text-down text-base font-bold">
              {bestOffer ? plain(bestOffer.price) : "–"}
            </div>
            <div className="num text-muted-foreground">
              {bestOffer ? `${plain(bestOffer.lots)} lot` : ""}
            </div>
          </div>
        </div>
        <DepthCurve book={book} className="mx-3 mt-2" />
        <BidBar book={book} />
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <table className="num w-full text-[12px]">
            <tbody>
              {Array.from({ length: n }, (_, i) => (
                <tr key={i} className="h-[20px] text-right">
                  <td className="pl-3 text-muted-foreground">
                    {book.bid[i] ? plain(book.bid[i]!.lots) : ""}
                  </td>
                  <td className="text-up pr-2 font-semibold">
                    {book.bid[i] ? plain(book.bid[i]!.price) : ""}
                  </td>
                  <td className="text-down pl-2 text-left font-semibold">
                    {book.offer[i] ? plain(book.offer[i]!.price) : ""}
                  </td>
                  <td className="pr-3 text-left text-muted-foreground">
                    {book.offer[i] ? plain(book.offer[i]!.lots) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => setFull((f) => !f)}
            className="w-full py-1 text-[11px] text-muted-foreground hover:underline"
          >
            {full ? "Show top 5" : "Show 20 levels"}
          </button>
        </div>
      </div>
    </Shell>
  )
}
