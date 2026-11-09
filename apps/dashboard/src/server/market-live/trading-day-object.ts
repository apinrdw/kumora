// The trading-day Durable Object: one per WIB date, named by it. It adapts
// Cloudflare's hibernatable websockets to trading-day.ts, which holds the
// behaviour. Exported from the Worker entry (src/worker.ts) as `TradingDay`,
// the class the dashboard stack declares.
import { WibDate } from "@workspace/relay"
import { runServerEffectResult } from "@workspace/server"
import { Effect, Result, Schema, Scope } from "effect"

import { HeldSessions, ObjectPath, ViewerHeader } from "./routes.ts"
import { makeTradingDay, type Peer, type PeerState } from "./trading-day.ts"

// Socket tags. A viewer socket also carries its user and session, so a ban or
// revoke can close it (apinrdw/kumora#144).
const INGEST = "ingest"
const VIEWER = "viewer"
const userTag = (userId: string) => `user:${userId}`
const SESSION = "session:"
const sessionTag = (sessionId: string) => `${SESSION}${sessionId}`

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
const decodeHeld = Schema.decodeUnknownEffect(HeldSessions)

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
    const viewersOf = (userId: string) =>
      Effect.sync(() =>
        ctx.getWebSockets(userTag(userId)).map((socket) => ({
          peer: peerOf(socket),
          sessionId:
            ctx
              .getTags(socket)
              .find((tag) => tag.startsWith(SESSION))
              ?.slice(SESSION.length) ?? "",
        }))
      )
    const ingests = Effect.sync(() =>
      ctx.getWebSockets(INGEST).map((socket) => peerOf(socket))
    )
    // Lives as long as the object; it holds the delta timers.
    const scope = Scope.makeUnsafe()
    this.day = Effect.runSync(
      makeTradingDay({ date, viewers, viewersOf, ingests }).pipe(
        Scope.provide(scope)
      )
    )
  }

  // Accepts the socket the Worker entry routed here, already gated, or the
  // sessions a user still holds (live-viewers.ts).
  fetch(request: Request): Response | Promise<Response> {
    const { pathname } = new URL(request.url)
    // The runner logs any failure.
    if (pathname === ObjectPath.endSessions)
      return runServerEffectResult(
        Effect.promise(() => request.json()).pipe(
          Effect.flatMap(decodeHeld),
          Effect.flatMap(this.day.endSessions)
        )
      ).then(
        (settled) =>
          new Response(null, { status: Result.isSuccess(settled) ? 204 : 500 })
      )
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
      this.ctx.getTags(socket).includes(VIEWER)
        ? this.day.viewerMessage(peer, text)
        : this.day.ingestMessage(peer, text)
    )
  }
}
