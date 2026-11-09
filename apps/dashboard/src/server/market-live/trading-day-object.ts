// The trading-day Durable Object: one per WIB date, named by it. It adapts
// Cloudflare's hibernatable websockets to trading-day.ts, which holds the
// behaviour. Exported from the Worker entry (src/worker.ts) as `TradingDay`,
// the class the dashboard stack declares.
import { WibDate, type StockCode } from "@workspace/relay"
import { runServerEffectResult } from "@workspace/server"
import { Effect, Option, Result, Schema, Scope } from "effect"

import type { CodeListStore } from "./code-list.ts"
import { HeldSessions, ObjectPath, ViewerHeader } from "./routes.ts"
import { makeTradingDay, type Peer, type PeerState } from "./trading-day.ts"

// Socket tags. A viewer socket also carries its user and session, so a ban or
// revoke can close it (apinrdw/kumora#144).
const INGEST = "ingest"
const VIEWER = "viewer"
const userTag = (userId: string) => `user:${userId}`
const SESSION = "session:"
const sessionTag = (sessionId: string) => `${SESSION}${sessionId}`

// A socket's attachment survives hibernation: its state, and a viewer's codes
// once it sent a Select. An ingest socket's is the bare state.
type Attachment =
  | PeerState
  | { readonly state: PeerState; readonly watching: ReadonlyArray<StockCode> }

const attachmentOf = (socket: WebSocket) => {
  const attachment = socket.deserializeAttachment() as Attachment | null
  // A socket without an attachment is new.
  if (attachment === null) return { state: "new" as const, watching: [] }
  return typeof attachment === "string"
    ? { state: attachment, watching: [] }
    : attachment
}

// Decision: a socket watching no codes keeps the bare state, so an ingest
// socket's attachment is always its state.
const attach = (
  socket: WebSocket,
  state: PeerState,
  watching: ReadonlyArray<StockCode>
) =>
  socket.serializeAttachment(
    watching.length === 0 ? state : { state, watching }
  )

const peerOf = (socket: WebSocket): Peer => ({
  send: (text) => Effect.sync(() => socket.send(text)),
  close: (code, reason) => Effect.sync(() => socket.close(code, reason)),
  state: Effect.sync(() => attachmentOf(socket).state),
  setState: (state) =>
    Effect.sync(() => attach(socket, state, attachmentOf(socket).watching)),
  watching: Effect.sync(() => attachmentOf(socket).watching),
  setWatching: (watching) =>
    Effect.sync(() => attach(socket, attachmentOf(socket).state, watching)),
})

const decodeDate = Schema.decodeUnknownSync(WibDate)
const decodeHeld = Schema.decodeUnknownEffect(HeldSessions)

const CODE_LIST_KEY = "code-list"

const codeListStore = (storage: DurableObjectStorage): CodeListStore => ({
  read: Effect.promise(() => storage.get<string>(CODE_LIST_KEY)).pipe(
    Effect.map(Option.fromUndefinedOr)
  ),
  write: (text) => Effect.promise(() => storage.put(CODE_LIST_KEY, text)),
})

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
      makeTradingDay({
        date,
        viewers,
        viewersOf,
        ingests,
        codeList: codeListStore(ctx.storage),
      }).pipe(Scope.provide(scope))
    )
  }

  // Accepts the socket the Worker entry routed here, already gated; answers
  // the sessions a user still holds (live-viewers.ts) and the day's stock
  // code list GET.
  fetch(request: Request): Response | Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === ObjectPath.codes) return this.codeList()
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

  private codeList() {
    return runServerEffectResult(this.day.codeList).then((settled) =>
      Result.isSuccess(settled)
        ? settled.success
        : new Response(null, { status: 500 })
    )
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

  // A viewer's codes leave the on-demand set when its socket closes.
  webSocketClose(socket: WebSocket) {
    if (!this.ctx.getTags(socket).includes(VIEWER)) return undefined
    return runServerEffectResult(this.day.viewerClosed(peerOf(socket)))
  }

  webSocketError(socket: WebSocket) {
    return this.webSocketClose(socket)
  }
}
