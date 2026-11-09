import {
  applyViewerMessage,
  clientRuntime,
  viewerMessages,
} from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
  type RunningTrade,
  type StockCode,
  type ViewerUp,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { useEffect, useRef, useState } from "react"

import { KButton } from "@/components/k/button"
import { compactIdr, plain, tapeTime } from "@/lib/format"
import { withRedirect } from "@/lib/redirect"

// The page shows this many of the trades it keeps; the tape ticket renders
// them all (apinrdw/kumora#150).
const SHOWN_TRADES = 200

// What the socket tells the object the page shows. The tape streams the whole
// market whatever is selected.
const selectOf = (selected: StockCode): ViewerUp => ({
  _tag: "Select",
  protocolVersion: ViewerProtocolVersion,
  selected,
  watchlist: [],
})

const SIDE_CLASS: Record<RunningTrade["side"], string> = {
  buy: "text-up",
  sell: "text-down",
  none: "",
}

type Status = "live" | "new-version"

type Source = RunningTrade["feeds"][number]

// One dot per feed that saw a trade, in the order the server lists them.
const SOURCES: ReadonlyArray<{
  readonly source: Source
  readonly label: string
  readonly dot: string
}> = [
  { source: "Stockbit", label: "Stockbit", dot: "bg-info" },
  { source: "Ajaib", label: "Ajaib", dot: "bg-vwap" },
  { source: "backfill", label: "Backfill", dot: "bg-neutral" },
]

function SourceDots({ feeds }: { feeds: ReadonlyArray<Source> }) {
  const shown = SOURCES.filter(({ source }) => feeds.includes(source))
  return (
    <span
      className="inline-flex gap-0.5"
      aria-label={shown.map(({ label }) => label).join(", ")}
      role="img"
    >
      {shown.map(({ source, dot }) => (
        <span key={source} className={`size-1.5 rounded-full ${dot}`} />
      ))}
    </span>
  )
}

// The whole-market tape from the viewer socket. A 4401 close sends the
// visitor to sign in and back; a 4426 close asks for a reload; any other close
// reconnects and starts over from a fresh snapshot. Clicking a trade selects
// its code; each change of `selected` is sent down the open socket.
// `onMessage` hears every viewer message too: the chart reads its candles.
export function LiveTape({
  selected,
  onSelect,
  onMessage,
}: {
  selected: StockCode
  onSelect: (code: StockCode) => void
  onMessage?: (message: ViewerDown) => void
}) {
  const [tape, setTape] = useState<ReadonlyArray<RunningTrade>>([])
  const [status, setStatus] = useState<Status>("live")
  const [select] = useState(() =>
    Effect.runSync(SubscriptionRef.make(selectOf(selected)))
  )

  // The latest listener, so a new one (the chart's store for a new code)
  // doesn't reopen the socket. Updated before the Select below goes out.
  const listener = useRef(onMessage)
  useEffect(() => {
    listener.current = onMessage
  }, [onMessage])

  useEffect(() => {
    clientRuntime.runFork(SubscriptionRef.set(select, selectOf(selected)))
  }, [select, selected])

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select,
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() => {
          listener.current?.(message)
          setTape((current) =>
            Effect.runSync(applyViewerMessage(current, message))
          )
        })
      ).pipe(
        Effect.catchTags({
          // A full load: the sign-in page reads its own session state.
          SignInRequired: () =>
            Effect.sync(() => {
              const { pathname, search } = window.location
              window.location.assign(
                withRedirect("/sign-in", `${pathname}${search}`)
              )
            }),
          NewVersion: () => Effect.sync(() => setStatus("new-version")),
        })
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [select])

  return (
    <section aria-label="Running trades" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Running trades</h2>
        <ul
          aria-label="Sources"
          className="flex gap-3 text-[11px] text-muted-foreground"
        >
          {SOURCES.map(({ source, label, dot }) => (
            <li key={source} className="inline-flex items-center gap-1">
              <span className={`size-1.5 rounded-full ${dot}`} />
              {label}
            </li>
          ))}
        </ul>
      </header>
      {status === "new-version" && (
        <div role="alert" className="flex items-center gap-3 text-[13px]">
          <span>A new version of Market Live is out. Reload to continue.</span>
          <KButton size="sm" onClick={() => window.location.reload()}>
            Reload
          </KButton>
        </div>
      )}
      <table className="w-full text-[13px] tabular-nums">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="font-normal">Time</th>
            <th className="font-normal">Code</th>
            <th className="text-right font-normal">Price</th>
            <th className="text-right font-normal">Lot</th>
            <th className="text-right font-normal">Value</th>
            <th className="font-normal">
              <span className="sr-only">Source</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tape.slice(0, SHOWN_TRADES).map((trade) => (
            <tr
              key={trade.tradeNumber}
              data-trade-number={trade.tradeNumber}
              className="hover:bg-elevated cursor-pointer"
              onClick={() => onSelect(trade.code)}
            >
              <td>{tapeTime(DateTime.toEpochMillis(trade.time))}</td>
              <td className="font-semibold">
                {/* The row's click target for the keyboard and screen readers. */}
                <button type="button" className="hover:underline">
                  {trade.code}
                </button>
              </td>
              <td className={`text-right ${SIDE_CLASS[trade.side]}`}>
                {plain(trade.price)}
              </td>
              <td className="text-right">{plain(trade.lots)}</td>
              <td className="text-right">
                {compactIdr(trade.price * trade.lots * 100).replace("+", "")}
              </td>
              <td className="pl-2">
                <SourceDots feeds={trade.feeds} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
