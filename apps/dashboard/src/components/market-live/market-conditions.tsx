import {
  auctionAt,
  type IndicativePrice,
  type MarketPhase,
  type MarketConditions,
  type RelayGap,
  type StockCode,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { useEffect, useState, useSyncExternalStore } from "react"

import { KStatusPill } from "@/components/k/status-pill"
import { dateTime, feedLag } from "@/lib/format"

// What the page knows besides the tape, from the viewer socket (spec
// apinrdw/kumora#138, "Freshness display"). `reconnecting` while the page's
// own socket is down: the feeds aren't blamed for it.
type View = {
  readonly conditions: MarketConditions | undefined
  // Each code's latest, the selected and watchlist codes' among them.
  readonly indicative: ReadonlyMap<StockCode, IndicativePrice>
  readonly connection: "connecting" | "live" | "reconnecting"
}

const initial: View = {
  conditions: undefined,
  indicative: new Map(),
  connection: "connecting",
}
let view = initial
const listeners = new Set<() => void>()

// Reads the view and writes what `next` makes of it in one operation: the
// socket's consumer and the socket's own fiber (live-tape.tsx) both publish,
// and a scheduler yield between a read and its write would let the other's
// write land in between and be lost.
const publish = (next: (held: View) => View) =>
  Effect.sync(() => {
    view = next(view)
    for (const listener of listeners) listener()
  })

const byCode = (prices: ReadonlyArray<IndicativePrice>) =>
  Effect.succeed(prices.map((price) => [price.code, price] as const))

// The view after one viewer message. A snapshot starts over.
// Decision: a delta's indicative prices are every code's that changed, and all
// are kept, so a code added to the watchlist mid-auction shows its price on the
// next change; the map is bounded by the listed codes. See apinrdw/kumora#157.
export const applyConditions = Effect.fnUntraced(function* (
  message: ViewerDown
) {
  if (message._tag === "Snapshot") {
    const indicative = new Map(yield* byCode(message.indicative ?? []))
    return yield* publish(() => ({
      conditions: message.conditions,
      indicative,
      connection: "live",
    }))
  }
  const prices = message.indicative ?? []
  if (message.conditions === undefined && prices.length === 0) return
  const arriving = yield* byCode(prices)
  return yield* publish((held) => ({
    ...held,
    conditions: message.conditions ?? held.conditions,
    indicative:
      prices.length === 0
        ? held.indicative
        : new Map([...held.indicative, ...arriving]),
  }))
})

export const conditionsReconnecting = publish((held) => ({
  ...held,
  connection: "reconnecting",
}))

// The page left: the next visit starts from its own snapshot.
export const resetConditions = publish(() => initial)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const current = () => view

function useMarketConditions(): View {
  return useSyncExternalStore(subscribe, current, current)
}

// The relay gaps so far: the tape shows each as a "not recorded" row.
export function useRelayGaps(): ReadonlyArray<RelayGap> {
  return useMarketConditions().conditions?.gaps ?? []
}

// Decision: the merged views (tape, candles, watchlist) are stale only when
// neither feed is live, or while the page's own socket reconnects; one feed
// down leaves them live, and its pill shows which (apinrdw/kumora#133).
export function useMergedStale(): boolean {
  const { conditions, connection } = useMarketConditions()
  if (connection === "reconnecting") return true
  if (conditions === undefined) return false
  return (
    conditions.feeds.Stockbit !== "live" && conditions.feeds.Ajaib !== "live"
  )
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

// `code`'s held price while the auction of its time is the phase the server
// says runs: the prices are held across phases, so without this the
// morning's would show at 15:50 until the closing auction's first frame
// (the server serves by the same rule, `market-conditions.ts`). The page
// compares the phase alone, not the date: a viewer socket is closed when its
// day ends (`trading-day.ts`, DayEnded), and the next day's snapshot replaces
// every held price, so a held price is always of today.
const auctionIndicative = Effect.fnUntraced(function* (code: StockCode) {
  const { conditions, indicative } = view
  const price = indicative.get(code)
  if (price === undefined || conditions === undefined) return undefined
  return (yield* auctionAt(price.at))?.phase === conditions.phase
    ? price
    : undefined
})

// `code`'s indicative price while its auction runs: the chart's dashed line
// and header, and the watchlist row's price. It re-renders only when that
// code's changes.
export function useAuctionIndicative(
  code: StockCode
): IndicativePrice | undefined {
  return useSyncExternalStore(
    subscribe,
    () => Effect.runSync(auctionIndicative(code)),
    () => undefined
  )
}

// The market phase, with the next open while the market is shut.
export function PhaseLabel({
  phase,
  nextOpen,
}: {
  phase: MarketPhase
  nextOpen?: DateTime.Utc | undefined
}) {
  return (
    <span aria-label="Market phase" className="font-medium">
      {PHASE[phase]}
      {nextOpen !== undefined && (
        <span className="font-normal text-muted-foreground">
          {" · opens "}
          {Effect.runSync(dateTime(DateTime.formatIso(nextOpen)))}
        </span>
      )}
    </span>
  )
}

const FEEDS = ["Stockbit", "Ajaib"] as const

// The chart header's market conditions: a freshness pill per feed and the
// market phase (with the next open while shut).
export function MarketConditionsBar() {
  const { conditions, connection } = useMarketConditions()
  if (conditions === undefined) return null
  const { phase, nextOpen, relayOnline, feeds, lags } = conditions
  return (
    <div
      role="group"
      aria-label="Market conditions"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
    >
      {connection === "reconnecting" ? (
        <span role="status" className="text-warning">
          Reconnecting…
        </span>
      ) : (
        <ul aria-label="Feeds" className="flex items-center gap-2">
          {FEEDS.map((feed) => {
            const lag = lags?.[feed]
            const behind =
              lag === undefined ? undefined : Effect.runSync(feedLag(lag))
            let reason: string | undefined
            if (!relayOnline) reason = "Relay offline"
            else if (behind !== undefined)
              reason = `Running trades arrive ${behind} behind the exchange`
            return (
              <li key={feed} className="inline-flex items-center gap-1">
                {feed}
                <KStatusPill
                  status={feeds[feed]}
                  {...(behind === undefined ? {} : { detail: behind })}
                  reason={reason}
                />
              </li>
            )
          })}
        </ul>
      )}
      <PhaseLabel phase={phase} nextOpen={nextOpen} />
    </div>
  )
}
