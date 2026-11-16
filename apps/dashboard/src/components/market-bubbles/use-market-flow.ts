import {
  StockCode,
  clientRuntime,
  fetchBubbles,
  viewerMessages,
} from "@workspace/client"
import {
  MarketLivePath,
  ViewerProtocolVersion,
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
import { useEffect, useState } from "react"

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
const SELECT: ViewerUp = {
  _tag: "Select",
  protocolVersion: ViewerProtocolVersion,
  selected: StockCode.make("IHSG"),
  watchlist: [],
}

const BACKFILL_RETRY = Schedule.spaced("15 seconds")

// `live` once a snapshot came; `new-version` when the Worker runs a newer
// viewer protocol and the page must reload.
export type FlowStatus = "connecting" | "live" | "new-version"

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

// The live day's market flow into `flow`: the viewer socket's deltas and
// tape, and the backfill after each snapshot, a reconnect's included;
// applyBubbles merges it without counting a minute twice.
const followMarketFlow = Effect.fnUntraced(
  function* (
    flow: MarketFlow,
    today: WibDate,
    setStatus: (status: FlowStatus) => void
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
        yield* applyTrades(flow, message.tape)
        if (message._tag === "Delta")
          return yield* applyCandles(flow, message.candles)
        yield* Effect.sync(() => setStatus("live"))
        yield* Effect.forkChild(loadBackfill(flow, today))
      })
    )
  },
  (effect, _flow, _today, setStatus) =>
    effect.pipe(
      Effect.catchTags({
        SignInRequired: () => signInAgain,
        NewVersion: () => Effect.sync(() => setStatus("new-version")),
      })
    )
)

// The live day's market flow, and the socket's status.
export function useMarketFlow(today: WibDate): {
  readonly flow: MarketFlow
  readonly status: FlowStatus
} {
  const [flow] = useState(() => Effect.runSync(makeMarketFlow()))
  const [status, setStatus] = useState<FlowStatus>("connecting")
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      followMarketFlow(flow, today, setStatus)
    )
    return () => {
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetConditions))
      )
    }
  }, [flow, today])
  return { flow, status }
}
