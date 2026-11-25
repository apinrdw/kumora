import { clientRuntime, viewerMessages } from "@workspace/client"
import {
  StockCode,
  ViewerProtocolVersion,
  type ViewerUp,
} from "@workspace/relay"
import { DateTime, Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"

import { useBookAlerts } from "@/components/book-alerts/use-book-alerts"
import { makeBookReadingsStore } from "@/components/market-live/book-readings-store"
import {
  applyConditions,
  conditionsReconnecting,
  resetConditions,
} from "@/components/market-live/market-conditions"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"
import { signInAgain } from "@/components/market-live/sign-in-again"

import { makeFiguresStore } from "./figures-store"
import { makeRadarEventsStore } from "./radar-events-store"

// The scanner selects its unfolded code, so the object sends that
// code's whole book (deltas carry whole books only for selected codes), and
// IHSG, which has no book, while none is unfolded. It sends the watchlist
// too: those codes stay live through Ajaib's book while Stockbit is stale.
// See spec apinrdw/kumora#517, "Data" and "The scanner".
const IHSG = StockCode.make("IHSG")

const selectOf = (
  unfolded: StockCode | undefined,
  watchlist: ReadonlyArray<StockCode>
): Effect.Effect<ViewerUp> =>
  Effect.succeed({
    _tag: "Select",
    protocolVersion: ViewerProtocolVersion,
    selected: unfolded ?? IHSG,
    watchlist,
  })

type FeedStatus = "connecting" | "live" | "new-version"

// The scanner's viewer socket: every code's readings, figures and book
// events, the
// unfolded code's book, the market conditions, and how far the market
// clock runs ahead of the browser's, from each message's sent instant.
// Every message feeds the browser's book event alerts too.
export function useRadarFeed(
  unfolded: StockCode | undefined,
  watchlist: ReadonlyArray<StockCode>
) {
  const [readings] = useState(() => Effect.runSync(makeBookReadingsStore))
  const [figures] = useState(() => Effect.runSync(makeFiguresStore))
  const [events] = useState(() => Effect.runSync(makeRadarEventsStore))
  const book = useMemo(
    () =>
      unfolded === undefined
        ? undefined
        : Effect.runSync(makeOrderBookStore(unfolded)),
    [unfolded]
  )
  const [status, setStatus] = useState<FeedStatus>("connecting")
  const clockOffset = useRef(0)
  const [select] = useState(() =>
    Effect.runSync(
      Effect.flatMap(selectOf(unfolded, watchlist), SubscriptionRef.make)
    )
  )
  useEffect(() => {
    clientRuntime.runFork(
      Effect.flatMap(selectOf(unfolded, watchlist), (next) =>
        SubscriptionRef.set(select, next)
      )
    )
  }, [select, unfolded, watchlist])
  // The latest book store, so a new unfolded code doesn't reopen the socket.
  const held = useRef(book)
  useEffect(() => {
    held.current = book
  }, [book])
  const tellAlerts = useBookAlerts()
  const heard = useRef(tellAlerts)
  useEffect(() => {
    heard.current = tellAlerts
  }, [tellAlerts])

  useEffect(() => {
    const messages = viewerMessages({
      select,
      onReconnecting: conditionsReconnecting,
    })
    const fiber = clientRuntime.runFork(
      Stream.runForEach(messages, (message) =>
        Effect.sync(() => {
          clockOffset.current = DateTime.toEpochMillis(message.at) - Date.now()
          readings.apply(message)
          figures.apply(message)
          events.apply(message)
          held.current?.apply(message)
          heard.current(message)
          if (message._tag === "Snapshot") setStatus("live")
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
  }, [select, readings, figures, events])

  return { readings, figures, events, book, status, clockOffset }
}
