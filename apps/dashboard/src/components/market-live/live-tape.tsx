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
import { SpeakerToggle } from "@/components/market-live/speaker-toggle"
import {
  SOURCES,
  TapeList,
  useFramedTape,
} from "@/components/market-live/tape-list"

import {
  applyConditions,
  conditionsReconnecting,
  resetConditions,
  useMergedStale,
  useRelayGaps,
} from "./market-conditions"
import { signInAgain } from "./sign-in-again"
import { tapeChangeOf } from "./tape-snapshots"

// What the socket tells the object the page shows. The tape streams the whole
// market whatever is selected.
const selectOf = (
  selected: StockCode,
  watchlist: ReadonlyArray<StockCode>
): Effect.Effect<ViewerUp> =>
  Effect.succeed({
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
    Effect.runSync(
      Effect.flatMap(selectOf(selected, watchlist), SubscriptionRef.make)
    )
  )

  // The latest listener, so a new one (the chart's store for a new code)
  // doesn't reopen the socket. Updated before the Select below goes out.
  const listener = useRef(onMessage)
  useEffect(() => {
    listener.current = onMessage
  }, [onMessage])

  // The code the socket last sent.
  const sent = useRef({ selected, watchlist })
  useEffect(() => {
    if (
      sent.current.selected === selected &&
      sent.current.watchlist === watchlist
    )
      return
    sent.current = { selected, watchlist }
    clientRuntime.runFork(
      Effect.flatMap(selectOf(selected, watchlist), (next) =>
        SubscriptionRef.set(select, next)
      )
    )
  }, [select, selected, watchlist])

  // Whether the next snapshot is the first on the current socket
  // (tape-snapshots.ts): so on open and after each drop.
  const firstOnSocket = useRef(true)

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    firstOnSocket.current = true
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select,
      onReconnecting: Effect.andThen(
        Effect.sync(() => {
          firstOnSocket.current = true
        }),
        conditionsReconnecting
      ),
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() => {
          listener.current?.(message)
          apply(Effect.runSync(tapeChangeOf(message, firstOnSocket.current)))
          if (message._tag === "Snapshot") firstOnSocket.current = false
        }).pipe(Effect.andThen(applyConditions(message)))
      ).pipe(
        Effect.catchTags({
          SignInRequired: () => signInAgain,
          NewVersion: () => Effect.sync(() => setStatus("new-version")),
        })
      )
    )
    return () => {
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetConditions))
      )
    }
  }, [apply, select])

  return (
    <TapeSection stale={stale} controls={<SpeakerToggle />}>
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
        live
        selected={selected}
        onSelect={onSelect}
        gaps={gaps}
        className={`${TAPE_HEIGHT} ${stale ? "opacity-50" : ""}`}
      />
    </TapeSection>
  )
}

export const TAPE_HEIGHT = "h-[min(70vh,640px)]"

// The tape's panel: its heading, `controls` (the live tape's Speaker
// toggle), the sources legend, then `children`.
export function TapeSection({
  stale = false,
  controls,
  children,
}: {
  stale?: boolean
  controls?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label="Running trades"
      data-stale={stale || undefined}
      className="flex flex-col gap-2"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Running trades
            {stale && <KStatusPill status="stale" />}
          </h2>
          {controls}
        </div>
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
