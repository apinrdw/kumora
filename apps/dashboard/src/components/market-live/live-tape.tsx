import { clientRuntime, viewerMessages } from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
  type StockCode,
  type ViewerDown,
  type ViewerUp,
} from "@workspace/relay"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { KButton } from "@/components/k/button"
import { KStatusPill } from "@/components/k/status-pill"
import {
  SOURCES,
  TapeList,
  useFramedTape,
} from "@/components/market-live/tape-list"

import {
  applyStatus,
  resetStatus,
  statusReconnecting,
  useMergedStale,
  useRelayGaps,
} from "./market-status"
import { signInAgain } from "./sign-in-again"

// What the socket tells the object the page shows. The tape streams the whole
// market whatever is selected.
const selectOf = (
  selected: StockCode,
  watchlist: ReadonlyArray<StockCode>
): ViewerUp => ({
  _tag: "Select",
  protocolVersion: ViewerProtocolVersion,
  selected,
  watchlist,
})

const NO_CODES: ReadonlyArray<StockCode> = []

type Status = "live" | "new-version"

// The whole-market tape from the viewer socket. A 4401 close sends the
// visitor to sign in and back; a 4426 close asks for a reload; any other close
// reconnects and starts over from a fresh snapshot. Clicking a trade selects
// its code; each change of `selected` or `watchlist` is sent down the open
// socket.
// `onMessage` hears every viewer message too: the chart reads its candles.
export function LiveTape({
  selected,
  watchlist = NO_CODES,
  onSelect,
  onMessage,
}: {
  selected: StockCode
  watchlist?: ReadonlyArray<StockCode>
  onSelect: (code: StockCode) => void
  onMessage?: (message: ViewerDown) => void
}) {
  const { tape, frame, apply } = useFramedTape()
  const [status, setStatus] = useState<Status>("live")
  const stale = useMergedStale()
  const gaps = useRelayGaps()
  const [select] = useState(() =>
    Effect.runSync(SubscriptionRef.make(selectOf(selected, watchlist)))
  )

  // The latest listener, so a new one (the chart's store for a new code)
  // doesn't reopen the socket. Updated before the Select below goes out.
  const listener = useRef(onMessage)
  useEffect(() => {
    listener.current = onMessage
  }, [onMessage])

  // The code the socket last sent, and whether the object's answer to a
  // changed Select is still due.
  const sent = useRef({ selected, watchlist })
  const reselected = useRef(false)
  useEffect(() => {
    if (
      sent.current.selected === selected &&
      sent.current.watchlist === watchlist
    )
      return
    sent.current = { selected, watchlist }
    reselected.current = true
    clientRuntime.runFork(
      SubscriptionRef.set(select, selectOf(selected, watchlist))
    )
  }, [select, selected, watchlist])

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select,
      onReconnecting: statusReconnecting,
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() => {
          listener.current?.(message)
          // Decision: the snapshot answering a changed Select is merged into
          // the tape like a delta. Replacing it would cut the 10,000 trades
          // the page keeps to the snapshot's 200 newest, and an auction
          // match's fold with them. The chart still takes it as a snapshot.
          if (message._tag === "Snapshot" && reselected.current) {
            reselected.current = false
            apply({
              _tag: "Delta",
              tape: message.tape,
              candles: message.candles,
            })
          } else apply(message)
        }).pipe(Effect.andThen(applyStatus(message, sent.current.selected)))
      ).pipe(
        Effect.catchTags({
          SignInRequired: () => signInAgain,
          NewVersion: () => Effect.sync(() => setStatus("new-version")),
        })
      )
    )
    return () => {
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetStatus))
      )
    }
  }, [apply, select])

  return (
    <TapeSection stale={stale}>
      {status === "new-version" && (
        <div role="alert" className="flex items-center gap-3 text-[13px]">
          <span>A new version of Market Live is out. Reload to continue.</span>
          <KButton size="sm" onClick={() => window.location.reload()}>
            Reload
          </KButton>
        </div>
      )}
      <TapeList
        tape={tape}
        frame={frame}
        selected={selected}
        onSelect={onSelect}
        gaps={gaps}
        className={`${TAPE_HEIGHT} ${stale ? "opacity-50" : ""}`}
      />
    </TapeSection>
  )
}

export const TAPE_HEIGHT = "h-[min(70vh,640px)]"

// The tape's panel: its heading, the sources legend, then `children`.
export function TapeSection({
  stale = false,
  children,
}: {
  stale?: boolean
  children: ReactNode
}) {
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
      {children}
    </section>
  )
}
