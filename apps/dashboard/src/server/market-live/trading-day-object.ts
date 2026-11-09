// The trading-day Durable Object: one per WIB date, named by it. It adapts
// Cloudflare's hibernatable websockets to trading-day.ts, which holds the
// behaviour. Exported from the Worker entry (src/worker.ts) as `TradingDay`,
// the class the dashboard stack declares.
import { WibDate } from "@workspace/relay"
import { runServerEffectResult } from "@workspace/server"
import { Effect, Schema, Scope } from "effect"

import { withMarketClock } from "./market-clock.ts"
import { ObjectPath, ViewerHeader } from "./routes.ts"
import { makeTradingDay, type Peer, type PeerState } from "./trading-day.ts"

// Socket tags. A viewer socket also carries its user and session, so a ban or
// revoke can close it (apinrdw/kumora#144).
const INGEST = "ingest"
const VIEWER = "viewer"
const userTag = (userId: string) => `user:${userId}`
const sessionTag = (sessionId: string) => `session:${sessionId}`

const peerOf = (socket: WebSocket): Peer => ({
  send: (text) => Effect.sync(() => socket.send(text)),
  close: (code, reason) => Effect.sync(() => socket.close(code, reason)),
  // The attachment survives hibernation; a socket without one is new.
  state: Effect.sync(
    () => (socket.deserializeAttachment() as PeerState | null) ?? "new"
  ),
  setState: (state) => Effect.sync(() => socket.serializeAttachment(state)),
})

const decodeDate = Schema.decodeUnknownSync(WibDate)

// Decision: a plain class, not `DurableObject` from `cloudflare:workers`: the
// object needs no RPC, and only the bridge may import that module. Each
// callback runs through the bridge's result runner, which logs any failure.
export class TradingDayObject {
  private readonly day

  constructor(private readonly ctx: DurableObjectState) {
    // The Worker entry reaches the object by name, so the name is set.
    const date = decodeDate(ctx.id.name)
    const viewers = Effect.sync(() =>
      ctx.getWebSockets(VIEWER).map((socket) => peerOf(socket))
    )
    // Lives as long as the object; it holds the delta timers.
    const scope = Scope.makeUnsafe()
    this.day = Effect.runSync(
      makeTradingDay({ date, viewers }).pipe(Scope.provide(scope))
    )
  }

  // Accepts the socket the Worker entry routed here, already gated.
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url)
    const userId = request.headers.get(ViewerHeader.userId) ?? ""
    const sessionId = request.headers.get(ViewerHeader.sessionId) ?? ""
    const tags =
      pathname === ObjectPath.live
        ? [VIEWER, userTag(userId), sessionTag(sessionId)]
        : [INGEST]
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], tags)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message)
    const peer = peerOf(socket)
    return runServerEffectResult(
      withMarketClock(
        this.ctx.getTags(socket).includes(VIEWER)
          ? this.day.viewerMessage(peer, text)
          : this.day.ingestMessage(peer, text)
      )
    )
  }

  // A relay's socket closing may leave the object with none: relay offline.
  webSocketClose(socket: WebSocket) {
    if (!this.ctx.getTags(socket).includes(INGEST)) return undefined
    const remaining = this.ctx
      .getWebSockets(INGEST)
      .filter(
        (other) =>
          other !== socket &&
          other.readyState === WebSocket.OPEN &&
          other.deserializeAttachment() === "ready"
      ).length
    return runServerEffectResult(
      withMarketClock(this.day.ingestClosed(remaining))
    )
  }

  webSocketError(socket: WebSocket) {
    return this.webSocketClose(socket)
  }
}
