import { StockCode, clientRuntime, viewerMessages } from "@workspace/client"
import { MarketLivePath, ViewerProtocolVersion } from "@workspace/relay"
import { Effect, Fiber, Stream } from "effect"
import { useEffect, useState } from "react"

import { KButton } from "@/components/k/button"
import {
  SOURCES,
  TapeList,
  useFramedTape,
} from "@/components/market-live/tape-list"
import { withRedirect } from "@/lib/redirect"

// Until the page selects a code (apinrdw/kumora#146), every viewer selects
// this one; the tape streams the whole market whatever is selected.
const SELECTED = StockCode.make("BBCA")

type Status = "live" | "new-version"

// The whole-market tape from the viewer socket. A 4401 close sends the
// visitor to sign in and back; a 4426 close asks for a reload; any other close
// reconnects and starts over from a fresh snapshot.
export function LiveTape() {
  const { tape, frame, apply } = useFramedTape()
  const [status, setStatus] = useState<Status>("live")

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
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() => apply(message))
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
  }, [apply])

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
        selected={SELECTED}
        className="h-[min(70vh,640px)]"
      />
    </section>
  )
}
