import {
  StockCode,
  clientRuntime,
  fetchBubbles,
  viewerMessages,
} from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
  type ViewerDown,
  type ViewerUp,
  type WibDate,
} from "@workspace/relay"
import {
  Effect,
  Fiber,
  Option,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  applyConditions,
  conditionsReconnecting,
  resetConditions,
} from "@/components/market-live/market-conditions"
import { signInAgain } from "@/components/market-live/sign-in-again"
import {
  applyBubbles,
  applyCandles,
  applyTrades,
  makeMarketFlow,
  type MarketFlow,
} from "@/lib/bubbles"

// Decision: the page selects IHSG on the viewer socket. Every delta carries
// every code's changed candles and the whole tape whatever is selected, and
// an index has no book or sweeps to send; the header strip reads IHSG's Day
// state from it (spec apinrdw/kumora#427, "The header strip").
const IHSG = StockCode.make("IHSG")
const SELECT: ViewerUp = {
  _tag: "Select",
  protocolVersion: ViewerProtocolVersion,
  selected: IHSG,
  watchlist: [],
}

const BACKFILL_RETRY = Schedule.spaced("15 seconds")

// `live` once a snapshot came; `new-version` when the Worker runs a newer
// viewer protocol and the page must reload.
export type FlowStatus = "connecting" | "live" | "new-version"

interface FlowListeners {
  readonly setStatus: (status: FlowStatus) => void
  // IHSG's last price, each time a message carries its Day state.
  readonly setIhsg: (last: number) => void
}

const noteIhsg = (message: ViewerDown, setIhsg: (last: number) => void) =>
  Effect.sync(() => {
    const state = message.dayStates?.find(({ code }) => code === IHSG)
    if (state !== undefined) setIhsg(state.last)
  })

// The backfill of `today` into `flow`; none once the day is sealed. A failed
// ask retries; a 401 sends the visitor to sign in and back.
const loadBackfill = (flow: MarketFlow, today: WibDate) =>
  fetchBubbles(today).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (body) => applyBubbles(flow, body),
      })
    ),
    Effect.catchTag("SignInRequired", () => signInAgain),
    Effect.tapError((error) =>
      Effect.logWarning("Bubbles backfill not loaded", error)
    ),
    Effect.retry(BACKFILL_RETRY)
  )

// A viewer message's tape and, in a delta, its candles into `flow`.
const feedFlow = (flow: MarketFlow, message: ViewerDown) =>
  Effect.andThen(
    applyTrades(flow, message.tape),
    message._tag === "Delta" ? applyCandles(flow, message.candles) : Effect.void
  )

// The live day's market flow into `flow`: the viewer socket's deltas and
// tape, and the backfill after each snapshot, a reconnect's included;
// applyBubbles merges it without counting a minute twice.
const followMarketFlow = Effect.fnUntraced(
  function* (
    flow: MarketFlow,
    today: WibDate,
    { setStatus, setIhsg }: FlowListeners
  ) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const select = yield* SubscriptionRef.make(SELECT)
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select,
      onReconnecting: conditionsReconnecting,
    })
    yield* Stream.runForEach(messages, (message) =>
      Effect.gen(function* () {
        yield* applyConditions(message)
        yield* noteIhsg(message, setIhsg)
        yield* feedFlow(flow, message)
        if (message._tag === "Delta") return
        yield* Effect.sync(() => setStatus("live"))
        yield* Effect.forkChild(loadBackfill(flow, today))
      })
    )
  },
  (effect, _flow, _today, { setStatus }) =>
    effect.pipe(
      Effect.catchTags({
        SignInRequired: () => signInAgain,
        NewVersion: () => Effect.sync(() => setStatus("new-version")),
      })
    )
)

// The live day's market flow, the socket's status, and IHSG's last price;
// none before its first Day state.
export function useMarketFlow(today: WibDate): {
  readonly flow: MarketFlow
  readonly status: FlowStatus
  readonly ihsg: number | undefined
} {
  const [flow] = useState(() => Effect.runSync(makeMarketFlow()))
  const [status, setStatus] = useState<FlowStatus>("connecting")
  const [ihsg, setIhsg] = useState<number | undefined>(undefined)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      followMarketFlow(flow, today, { setStatus, setIhsg })
    )
    return () => {
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetConditions))
      )
    }
  }, [flow, today])
  return { flow, status, ihsg }
}

// The live day's market flow fed by a viewer socket the caller already has:
// `apply` takes each of its messages, and each snapshot asks the backfill
// again, the last ask dropped.
export function useFedMarketFlow(today: WibDate): {
  readonly flow: MarketFlow
  readonly apply: (message: ViewerDown) => void
} {
  const [flow] = useState(() => Effect.runSync(makeMarketFlow()))
  const backfill = useRef<Fiber.Fiber<void, unknown> | undefined>(undefined)
  const drop = useCallback(() => {
    const last = backfill.current
    backfill.current = undefined
    if (last !== undefined) clientRuntime.runFork(Fiber.interrupt(last))
  }, [])
  useEffect(() => drop, [drop])
  const apply = useCallback(
    (message: ViewerDown) => {
      Effect.runSync(feedFlow(flow, message))
      if (message._tag !== "Snapshot") return
      drop()
      backfill.current = clientRuntime.runFork(loadBackfill(flow, today))
    },
    [flow, today, drop]
  )
  return { flow, apply }
}
