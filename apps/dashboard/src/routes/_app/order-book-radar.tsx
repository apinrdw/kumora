import { createFileRoute } from "@tanstack/react-router"
import type { BookEvent, StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { useCallback, useMemo, useState } from "react"

import { AlertRules, AlertsBell } from "@/components/book-alerts/alerts-header"
import { KButton } from "@/components/k/button"
import {
  MarketConditionsBar,
  useStockbitBehind,
} from "@/components/market-live/market-conditions"
import { useSpecialBoard } from "@/components/market-live/use-special-board"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { BookEventFeed } from "@/components/order-book-radar/book-event-feed"
import type { RadarEventsStore } from "@/components/order-book-radar/radar-events-store"
import { Halves } from "@/components/order-book-radar/scanner"
import { Toolbar } from "@/components/order-book-radar/toolbar"
import { useRadarFeed } from "@/components/order-book-radar/use-radar-feed"
import { useRadarSettings } from "@/components/order-book-radar/use-radar-settings"
import { useRanking } from "@/components/order-book-radar/use-ranking"
import { bookEventKey } from "@/lib/book-events"
import { DISCLAIMER } from "@/lib/book-readings"
import type { Scan } from "@/lib/order-book-radar"

// The order book radar's scanner: live only (spec apinrdw/kumora#517, "The
// scanner").
export const Route = createFileRoute("/_app/order-book-radar")({
  staticData: {
    feature: "market-live",
    crumbs: () => Effect.succeed([{ label: "Order book radar" }]),
  },
  head: () => ({ meta: [{ title: "Order book radar · KUMORA Terminal" }] }),
  component: OrderBookRadarPage,
})

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

// The line under the toolbar: how many codes the floor lets in, and which
// codes are never ranked and why.
const coverageNote = (scan: Scan) =>
  `${plural(scan.above, "code", "codes")} above the floor · ${plural(scan.board, "Special Monitoring Board code", "Special Monitoring Board codes")} and ${plural(scan.cheap, "code", "codes")} at Rp1–10 are not ranked · rows with no book change for 60 s grey out and sink`

// The rows' book events as of now, shown live between re-sorts; the feed's
// codes; and the way to Market Live at an event, which its readout's list
// picks once it lands.
function useScannerEvents(
  store: RadarEventsStore,
  scan: Scan,
  marketNow: number
) {
  const navigate = Route.useNavigate()
  const openAt = useCallback(
    (event: BookEvent) =>
      void navigate({
        to: "/market-live",
        search: {
          code: event.code,
          event: Effect.runSync(bookEventKey(event)),
        },
      }),
    [navigate]
  )
  const events = useMemo(() => store.byCode(marketNow), [store, marketNow])
  const codes = useMemo(
    () =>
      new Set([
        ...scan.bid,
        ...scan.offer,
        ...scan.limits.map(({ code }) => code),
      ]),
    [scan]
  )
  return { events, codes, openAt }
}

function OrderBookRadarPage() {
  const [unfolded, setUnfolded] = useState<StockCode | undefined>(undefined)
  const watchlist = useWatchlist()
  const watched = useMemo(() => new Set(watchlist.codes), [watchlist.codes])
  const board = useSpecialBoard()
  const { settings, change } = useRadarSettings()
  const feed = useRadarFeed(unfolded, watchlist.codes)
  const [hovering, setHovering] = useState(false)
  const { scan, marketNow, resortsIn } = useRanking({
    readings: feed.readings,
    figures: feed.figures,
    events: feed.events,
    settings,
    board,
    watchlist: watched,
    clockOffset: feed.clockOffset,
    hovering,
  })
  const stockbitBehind = useStockbitBehind()
  const navigate = Route.useNavigate()
  const open = useCallback(
    (code: StockCode) =>
      void navigate({ to: "/market-live", search: { code } }),
    [navigate]
  )
  const scanner = useScannerEvents(feed.events, scan, marketNow)
  return (
    <div data-feed={feed.status} className="flex flex-col gap-2.5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Order book radar</h1>
          <p className="text-xs text-muted-foreground">
            Every code above your value floor, split by which side of its best 5
            levels holds more lots.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AlertRules />
          <AlertsBell />
          <MarketConditionsBar />
        </div>
      </header>
      {feed.status === "new-version" && (
        <div role="alert" className="flex items-center gap-3 text-[13px]">
          <span>
            A new version of the order book radar is out. Reload to continue.
          </span>
          <KButton size="sm" onClick={() => window.location.reload()}>
            Reload
          </KButton>
        </div>
      )}
      {stockbitBehind && (
        <div
          role="alert"
          className="border-warning/45 bg-warning/15 rounded-md border px-2.5 py-2 text-[12px]"
        >
          Stockbit is stale. Only codes with an Ajaib book (your selected and
          watchlist codes) are live; the rest show their last book until
          Stockbit is back.
        </div>
      )}
      <Toolbar
        settings={settings}
        onChange={change}
        note={`Halves split by imbalance sign · ${hovering ? "order held" : `re-sorts in ${resortsIn}s`}`}
      />
      <p aria-label="Coverage" className="text-[12px] text-muted-foreground">
        {coverageNote(scan)}
      </p>
      {/* The Book events feed sits beside the halves from 1,100 px, and under
          them below. */}
      <div className="grid items-start gap-2.5 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <Halves
          scan={scan}
          onHover={setHovering}
          view={{
            readings: feed.readings,
            rankBy: settings.rankBy,
            marketNow,
            watchlist: watched,
            events: scanner.events,
            unfolded,
            onUnfold: setUnfolded,
            book: feed.book,
            onOpen: open,
          }}
        />
        <BookEventFeed
          store={feed.events}
          codes={scanner.codes}
          onOpen={scanner.openAt}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{DISCLAIMER}</p>
    </div>
  )
}
