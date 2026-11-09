import {
  StockCode,
  applyViewerMessage,
  clientRuntime,
  viewerMessages,
} from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect, Fiber, Stream } from "effect"
import { useEffect, useState } from "react"

import { KButton } from "@/components/k/button"
import { KStatusPill } from "@/components/k/status-pill"
import { compactIdr, plain, tapeTime } from "@/lib/format"
import { withRedirect } from "@/lib/redirect"

import { withGapRows } from "./gap-rows"
import {
  applyStatus,
  resetStatus,
  statusReconnecting,
  useMergedStale,
  useRelayGaps,
} from "./market-status"

// The page shows this many of the trades it keeps; the tape ticket renders
// them all (apinrdw/kumora#150).
const SHOWN_TRADES = 200

// Until the page selects a code (apinrdw/kumora#146), every viewer selects
// this one; the tape streams the whole market whatever is selected.
const SELECTED = StockCode.make("BBCA")

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
// reconnects and starts over from a fresh snapshot.
export function LiveTape() {
  const [tape, setTape] = useState<ReadonlyArray<RunningTrade>>([])
  const [status, setStatus] = useState<Status>("live")
  const stale = useMergedStale()
  const gaps = useRelayGaps()

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select: {
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: SELECTED,
        watchlist: [],
      },
      onReconnecting: statusReconnecting,
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() =>
          setTape((current) =>
            Effect.runSync(applyViewerMessage(current, message))
          )
        ).pipe(Effect.andThen(applyStatus(message, SELECTED)))
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
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetStatus))
      )
    }
  }, [])

  return (
    <section
      aria-label="Running trades"
      data-stale={stale || undefined}
      className="flex flex-col gap-2"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Running trades
          {stale && <KStatusPill status="stale" />}
        </h2>
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
      <table
        className={`w-full text-[13px] tabular-nums ${stale ? "opacity-50" : ""}`}
      >
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
          {Effect.runSync(withGapRows(tape.slice(0, SHOWN_TRADES), gaps)).map(
            (row) =>
              row.kind === "gap" ? (
                <tr
                  key={`gap-${DateTime.toEpochMillis(row.gap.from)}`}
                  data-relay-gap
                >
                  <td
                    colSpan={6}
                    className="py-1 text-center text-muted-foreground"
                  >
                    Not recorded ·{" "}
                    {tapeTime(DateTime.toEpochMillis(row.gap.from))}–
                    {row.gap.to === undefined
                      ? "now"
                      : tapeTime(DateTime.toEpochMillis(row.gap.to))}
                  </td>
                </tr>
              ) : (
                <TradeRow key={row.trade.tradeNumber} trade={row.trade} />
              )
          )}
        </tbody>
      </table>
    </section>
  )
}

function TradeRow({ trade }: { trade: RunningTrade }) {
  return (
    <tr data-trade-number={trade.tradeNumber}>
      <td>{tapeTime(DateTime.toEpochMillis(trade.time))}</td>
      <td className="font-semibold">{trade.code}</td>
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
  )
}
