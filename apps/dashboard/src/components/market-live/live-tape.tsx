import { clientRuntime, viewerMessages } from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
  type StockCode,
  type ViewerDown,
  type ViewerUp,
} from "@workspace/relay"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { useEffect, useRef, useState } from "react"

import { KButton } from "@/components/k/button"
import {
  SOURCES,
  TapeList,
  useFramedTape,
} from "@/components/market-live/tape-list"
import { withRedirect } from "@/lib/redirect"

// What the socket tells the object the page shows. The tape streams the whole
// market whatever is selected.
const selectOf = (selected: StockCode): ViewerUp => ({
  _tag: "Select",
  protocolVersion: ViewerProtocolVersion,
  selected,
  watchlist: [],
})

type Status = "live" | "new-version"

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
  const { tape, frame, apply } = useFramedTape()
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

  // The code the socket last sent, and whether the object's answer to a
  // changed Select is still due.
  const sent = useRef(selected)
  const reselected = useRef(false)
  useEffect(() => {
    if (sent.current === selected) return
    sent.current = selected
    reselected.current = true
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
          // Decision: the snapshot answering a changed Select is merged into
          // the tape like a delta. Replacing it would cut the 10,000 trades
          // the page keeps to the snapshot's 200 newest, and an auction
          // match's fold with them. The chart still takes it as a snapshot.
          if (message._tag === "Snapshot" && reselected.current) {
            reselected.current = false
            apply({ ...message, _tag: "Delta" })
          } else apply(message)
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
  }, [apply, select])

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
      <TapeList
        tape={tape}
        frame={frame}
        selected={selected}
        onSelect={onSelect}
        className="h-[min(70vh,640px)]"
      />
    </section>
  )
}
