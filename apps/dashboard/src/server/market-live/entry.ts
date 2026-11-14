// Market Live's routes in the custom Worker entry (src/worker.ts), ahead of
// TanStack Start: the ingest socket and the viewer socket. Both reach today's
// trading-day Durable Object, named by the WIB date; the recorded day GETs
// (days.ts) and the broker codes route (broker-codes-route.ts) reach the
// object of the day they name, and the day strip the index object.
import {
  DayStripPath,
  MarketLivePath,
  ViewerCloseCode,
  brokerCodesDay,
  recordedDayRequest,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Option, Schema } from "effect"

import { Auth } from "../auth/auth.ts"
import { brokerCodesRoute } from "./broker-codes-route.ts"
import { dayStripRoute, recordedDayRoute } from "./days.ts"
import { gateLiveViewer } from "./gate.ts"
import { marketClockOffset, marketToday } from "./market-clock.ts"
import { ObjectPath, SessionEnd, ViewerHeader } from "./routes.ts"

const encodeSessionEnd = Schema.encodeSync(SessionEnd)

const toTradingDay = Effect.fnUntraced(function* (
  path: (typeof ObjectPath)[keyof typeof ObjectPath],
  headers: Readonly<Record<string, string>>
) {
  const env = yield* WorkerEnv
  const today = yield* marketToday
  const object = env.TRADING_DAY.getByName(today)
  // A new request, so only these headers reach the object.
  const request = new Request(new URL(path, "https://trading-day.invalid"), {
    headers: { Upgrade: "websocket", ...headers },
  })
  return yield* Effect.promise(() => object.fetch(request))
})

// A socket the entry accepts only to close: the browser reads this code,
// where a refused handshake would reach it as 1006.
const closedSocket = Effect.fnUntraced(function* (
  code: number,
  reason: string
) {
  const pair = new WebSocketPair()
  pair[1].accept()
  pair[1].close(code, reason)
  return new Response(null, { status: 101, webSocket: pair[0] })
})

const signInRequired = closedSocket(ViewerCloseCode.SignInRequired, "Sign in")

const notUpgrade = Effect.sync(
  () => new Response("Expected a websocket upgrade", { status: 426 })
)

const isUpgrade = (request: Request) =>
  Effect.sync(
    () => request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  )

// The ingest token is checked by the object, from the first message: the
// extension's `chrome-extension://` origin carries no session.
const ingest = Effect.fnUntraced(function* (request: Request) {
  if (!(yield* isUpgrade(request))) return yield* notUpgrade
  return yield* toTradingDay(ObjectPath.ingest, {})
})

const live = Effect.fnUntraced(
  function* (request: Request) {
    if (!(yield* isUpgrade(request))) return yield* notUpgrade
    const viewer = yield* gateLiveViewer(request)
    // The session ends on the Worker's clock; the object reads its own.
    const sessionEnd =
      DateTime.toEpochMillis(viewer.sessionEnd) + (yield* marketClockOffset)
    return yield* toTradingDay(ObjectPath.live, {
      [ViewerHeader.userId]: viewer.userId,
      [ViewerHeader.sessionId]: viewer.sessionId,
      [ViewerHeader.sessionEnd]: encodeSessionEnd(sessionEnd),
    })
  },
  // This surface's HTTP errors: every denial closes the socket with 4401.
  Effect.catchTags({
    Unauthorized: () => signInRequired,
    NotFound: () => signInRequired,
    Forbidden: () => signInRequired,
  }),
  Effect.provide(Auth.layer)
)

// The route for a Market Live path, or none for TanStack Start's.
export const marketLiveRoute = Effect.fnUntraced(function* (request: Request) {
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname === MarketLivePath.ingest) return Option.some(ingest(request))
  if (pathname === MarketLivePath.live) return Option.some(live(request))
  const brokerCodes = yield* brokerCodesDay(pathname)
  if (Option.isSome(brokerCodes))
    return Option.some(brokerCodesRoute(request, brokerCodes.value))
  if (pathname === DayStripPath)
    return Option.some(dayStripRoute(request).pipe(Effect.provide(Auth.layer)))
  const recorded = yield* recordedDayRequest(url)
  if (Option.isSome(recorded))
    return Option.some(
      recordedDayRoute(request, url, recorded.value.date).pipe(
        Effect.provide(Auth.layer)
      )
    )
  return Option.none()
})
