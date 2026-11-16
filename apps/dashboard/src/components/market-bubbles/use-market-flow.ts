import {
  StockCode,
  clientRuntime,
  fetchBubbles,
  viewerMessages,
} from "@workspace/client"
import {
  FLUSH_PAST_MINUTE,
  MarketLivePath,
  MINUTE_MS,
  ViewerProtocolVersion,
  type ViewerDown,
  type ViewerUp,
  type WibDate,
} from "@workspace/relay"
import {
  Clock,
  Duration,
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
  applyMessage,
  makeMarketFlow,
  missingFromBackfill,
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

// The backfill of `today` into `flow`, past the browser's copy when
// `fresh`; whether one came, none once the day is sealed. A failed ask
// retries; a 401 sends the visitor to sign in and back.
const loadBackfill = (flow: MarketFlow, today: WibDate, fresh: boolean) =>
  fetchBubbles(today, fresh).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(false),
        onSome: (body) => Effect.as(applyBubbles(flow, body), true),
      })
    ),
    Effect.catchTag("SignInRequired", () => Effect.as(signInAgain, false)),
    Effect.tapError((error) =>
      Effect.logWarning("Bubbles backfill not loaded", error)
    ),
    Effect.retry(BACKFILL_RETRY)
  )

// The Worker builds the backfill at its flush; the page asks a second later.
const ASKED_PAST_MINUTE = FLUSH_PAST_MINUTE + 1000

// Until the next backfill build is out, on the market clock, `clockOffset`
// ms ahead of the browser's.
const untilBuilt = (clockOffset: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => {
    const past = (now + clockOffset - ASKED_PAST_MINUTE) % MINUTE_MS
    return Effect.sleep(
      Duration.millis(MINUTE_MS - ((past + MINUTE_MS) % MINUTE_MS))
    )
  })

// The backfill into `flow` after a snapshot: the browser's copy, then a
// fresh one after each build while the flow waits for one
// (missingFromBackfill).
// Decision: the asks are timed by the browser's clock and `clockOffset`,
// and nothing rests on that timing: a body settled short of the snapshot or
// a recount (applyBubbles), as one asked for before its build, costs one
// more GET a minute later, never a trade. See apinrdw/kumora#436 and spec
// #427.
const followBackfill = Effect.fnUntraced(function* (
  flow: MarketFlow,
  today: WibDate,
  clockOffset: number
) {
  let following = yield* loadBackfill(flow, today, false)
  while (following) {
    yield* untilBuilt(clockOffset)
    if (yield* missingFromBackfill(flow))
      following = yield* loadBackfill(flow, today, true)
  }
})

// The live day's market flow into `flow`: the viewer socket's deltas and
// tape, and the backfill after each snapshot, a reconnect's included, the
// last snapshot's ask dropped; applyBubbles merges it without counting a
// minute twice.
const followMarketFlow = Effect.fnUntraced(
  function* (
    flow: MarketFlow,
    { today, clockOffset }: DayClock,
    { setStatus, setIhsg }: FlowListeners
  ) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws"
    const select = yield* SubscriptionRef.make(SELECT)
    const messages = viewerMessages({
      url: `${scheme}://${window.location.host}${MarketLivePath.live}`,
      select,
      onReconnecting: conditionsReconnecting,
    })
    let backfill: Fiber.Fiber<void, unknown> | undefined
    yield* Stream.runForEach(messages, (message) =>
      Effect.gen(function* () {
        yield* applyConditions(message)
        yield* noteIhsg(message, setIhsg)
        yield* applyMessage(flow, message)
        if (message._tag === "Delta") return
        yield* Effect.sync(() => setStatus("live"))
        if (backfill !== undefined) yield* Fiber.interrupt(backfill)
        backfill = yield* Effect.forkChild(
          followBackfill(flow, today, clockOffset)
        )
      })
    )
  },
  (effect, _flow, _clock, { setStatus }) =>
    effect.pipe(
      Effect.catchTags({
        SignInRequired: () => signInAgain,
        NewVersion: () => Effect.sync(() => setStatus("new-version")),
      })
    )
)

// The live day, and how far the market clock runs ahead of the browser's,
// in ms.
interface DayClock {
  readonly today: WibDate
  readonly clockOffset: number
}

// A fresh market flow for each day, so a page open overnight starts the new
// day empty.
function useDayFlow(today: WibDate): MarketFlow {
  const [held, setHeld] = useState(() => ({
    today,
    flow: Effect.runSync(makeMarketFlow()),
  }))
  if (held.today === today) return held.flow
  const next = { today, flow: Effect.runSync(makeMarketFlow()) }
  setHeld(next)
  return next.flow
}

// The live day's market flow, the socket's status, and IHSG's last price;
// none before its first Day state.
export function useMarketFlow(
  today: WibDate,
  clockOffset: number
): {
  readonly flow: MarketFlow
  readonly status: FlowStatus
  readonly ihsg: number | undefined
} {
  const flow = useDayFlow(today)
  const [status, setStatus] = useState<FlowStatus>("connecting")
  const [ihsg, setIhsg] = useState<number | undefined>(undefined)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      followMarketFlow(flow, { today, clockOffset }, { setStatus, setIhsg })
    )
    return () => {
      clientRuntime.runFork(
        Fiber.interrupt(fiber).pipe(Effect.andThen(resetConditions))
      )
    }
  }, [flow, today, clockOffset])
  return { flow, status, ihsg }
}

// The live day's market flow fed by a viewer socket the caller already has:
// `apply` takes each of its messages, and each snapshot follows the backfill
// again, the last one dropped.
export function useFedMarketFlow(
  today: WibDate,
  clockOffset: number
): {
  readonly flow: MarketFlow
  readonly apply: (message: ViewerDown) => void
} {
  const flow = useDayFlow(today)
  const backfill = useRef<
    { flow: MarketFlow; fiber: Fiber.Fiber<void, unknown> } | undefined
  >(undefined)
  // Stops the backfill that follows `of`, if one does.
  const drop = useCallback((of: MarketFlow) => {
    const last = backfill.current
    if (last === undefined || last.flow !== of) return
    backfill.current = undefined
    clientRuntime.runFork(Fiber.interrupt(last.fiber))
  }, [])
  // A day's backfill stops with its flow.
  useEffect(() => () => drop(flow), [drop, flow])
  const apply = useCallback(
    (message: ViewerDown) => {
      Effect.runSync(applyMessage(flow, message))
      if (message._tag !== "Snapshot") return
      drop(flow)
      backfill.current = {
        flow,
        fiber: clientRuntime.runFork(followBackfill(flow, today, clockOffset)),
      }
    },
    [flow, today, clockOffset, drop]
  )
  return { flow, apply }
}
