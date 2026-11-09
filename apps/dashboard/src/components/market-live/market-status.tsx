import type {
  IndicativePrice,
  MarketPhase,
  MarketStatus,
  RelayGap,
  StockCode,
  ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { useEffect, useState, useSyncExternalStore } from "react"

import { KStatusPill } from "@/components/k/status-pill"
import { dateTime, plain, shares } from "@/lib/format"

// What the page knows besides the tape, from the viewer socket (spec
// apinrdw/kumora#138, "Freshness display"). `reconnecting` while the page's
// own socket is down: the feeds aren't blamed for it.
type View = {
  readonly status: MarketStatus | undefined
  readonly indicative: IndicativePrice | undefined
  readonly connection: "connecting" | "live" | "reconnecting"
}

const initial: View = {
  status: undefined,
  indicative: undefined,
  connection: "connecting",
}
let view = initial
const listeners = new Set<() => void>()

const publish = (next: View) =>
  Effect.sync(() => {
    view = next
    for (const listener of listeners) listener()
  })

// The view after one viewer message for `selected`. A snapshot starts over.
export const applyStatus = (message: ViewerDown, selected: StockCode) =>
  Effect.suspend(() => {
    if (message._tag === "Snapshot")
      return publish({
        status: message.status,
        indicative: message.indicative,
        connection: "live",
      })
    const indicative = (message.indicative ?? []).find(
      (price) => price.code === selected
    )
    if (message.status === undefined && indicative === undefined)
      return Effect.void
    return publish({
      ...view,
      status: message.status ?? view.status,
      indicative: indicative ?? view.indicative,
    })
  })

export const statusReconnecting = Effect.suspend(() =>
  publish({ ...view, connection: "reconnecting" })
)

// The page left: the next visit starts from its own snapshot.
export const resetStatus = Effect.suspend(() => publish(initial))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const current = () => view

function useMarketStatus(): View {
  return useSyncExternalStore(subscribe, current, current)
}

// The relay gaps so far: the tape shows each as a "not recorded" row.
export function useRelayGaps(): ReadonlyArray<RelayGap> {
  return useMarketStatus().status?.gaps ?? []
}

// Decision: the merged views (tape, candles, watchlist) are stale only when
// neither feed is live, or while the page's own socket reconnects; one feed
// down leaves them live, and its pill shows which (apinrdw/kumora#133).
export function useMergedStale(): boolean {
  const { status, connection } = useMarketStatus()
  if (connection === "reconnecting") return true
  if (status === undefined) return false
  return status.feeds.Stockbit !== "live" && status.feeds.Ajaib !== "live"
}

// "STALE · 12s ago" over figures as of `at`, counting each second.
export function StaleSince({ at }: { at: DateTime.Utc }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(
    0,
    Math.floor((now - DateTime.toEpochMillis(at)) / 1000)
  )
  return (
    <span className="text-warning text-[11px] font-semibold tracking-[0.04em]">
      STALE · {seconds}s ago
    </span>
  )
}

const PHASE: Record<MarketPhase, string> = {
  "pre-opening": "Pre-opening",
  "session-1": "Session 1",
  break: "Break",
  "session-2": "Session 2",
  "pre-closing": "Pre-closing",
  "post-trading": "Post-trading",
  closed: "Closed",
  holiday: "Holiday",
}

// The auctions, when the indicative price is shown.
const AUCTIONS: ReadonlySet<MarketPhase> = new Set([
  "pre-opening",
  "pre-closing",
])

// The selected code's indicative price while an auction runs, for the
// chart's dashed line.
export function useAuctionIndicative(): number | undefined {
  const { status, indicative } = useMarketStatus()
  return status !== undefined && AUCTIONS.has(status.phase)
    ? indicative?.price
    : undefined
}

const FEEDS = ["Stockbit", "Ajaib"] as const

// The chart header's status: a freshness pill per feed, the market phase
// (with the next open while shut) and, during the auctions, the selected
// code's indicative price and volume.
export function MarketStatusBar() {
  const { status, indicative, connection } = useMarketStatus()
  if (status === undefined) return null
  const { phase, nextOpen, relayOnline, feeds } = status
  return (
    <div
      role="group"
      aria-label="Market status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
    >
      {connection === "reconnecting" ? (
        <span role="status" className="text-warning">
          Reconnecting…
        </span>
      ) : (
        <ul aria-label="Feeds" className="flex items-center gap-2">
          {FEEDS.map((feed) => (
            <li key={feed} className="inline-flex items-center gap-1">
              {feed}
              <KStatusPill
                status={feeds[feed]}
                reason={relayOnline ? undefined : "Relay offline"}
              />
            </li>
          ))}
        </ul>
      )}
      <span aria-label="Market phase" className="font-medium">
        {PHASE[phase]}
        {nextOpen !== undefined && (
          <span className="font-normal text-muted-foreground">
            {" · opens "}
            {dateTime(DateTime.formatIso(nextOpen))}
          </span>
        )}
      </span>
      {AUCTIONS.has(phase) && indicative !== undefined && (
        <span aria-label="Indicative price" className="num">
          IEP {plain(indicative.price)} · {shares(indicative.volume)}
        </span>
      )}
    </div>
  )
}
