// Market Live's routes in the custom Worker entry (src/worker.ts), ahead of
// TanStack Start: the ingest socket and the viewer socket. Both reach today's
// trading-day Durable Object, named by the WIB date.
import { MarketLivePath, ViewerCloseCode, wibDateAt } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Option } from "effect"

import { Auth } from "../auth/auth.ts"
import { gateLiveViewer } from "./gate.ts"
import { withMarketClock } from "./market-clock.ts"
import { ObjectPath, ViewerHeader } from "./routes.ts"

const toTradingDay = Effect.fnUntraced(function* (
  path: (typeof ObjectPath)[keyof typeof ObjectPath],
  headers: Readonly<Record<string, string>>
) {
  const env = yield* WorkerEnv
  const today = yield* withMarketClock(Effect.flatMap(DateTime.now, wibDateAt))
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

const notUpgrade = Effect.sync(
  () => new Response("Expected a websocket upgrade", { status: 426 })
)

const isUpgrade = (request: Request) =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket"

// The ingest token is checked by the object, from the first message: the
// extension's `chrome-extension://` origin carries no session.
const ingest = (request: Request) =>
  isUpgrade(request) ? toTradingDay(ObjectPath.ingest, {}) : notUpgrade

const live = Effect.fnUntraced(function* (request: Request) {
  if (!isUpgrade(request)) return yield* notUpgrade
  const viewer = yield* gateLiveViewer(request)
  if (Option.isNone(viewer))
    return yield* closedSocket(ViewerCloseCode.SignInRequired, "Sign in")
  return yield* toTradingDay(ObjectPath.live, {
    [ViewerHeader.userId]: viewer.value.userId,
    [ViewerHeader.sessionId]: viewer.value.sessionId,
  })
}, Effect.provide(Auth.layer))

// The route for a Market Live path, or undefined for TanStack Start's.
export const marketLiveRoute = (request: Request) => {
  const { pathname } = new URL(request.url)
  if (pathname === MarketLivePath.ingest) return ingest(request)
  if (pathname === MarketLivePath.live) return live(request)
  return undefined
}
