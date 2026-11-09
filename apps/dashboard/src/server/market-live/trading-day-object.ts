// The trading-day Durable Object: one per WIB date, named by it. It adapts
// Cloudflare's hibernatable websockets to trading-day.ts, which holds the
// behaviour. Exported from the Worker entry (src/worker.ts) as `TradingDay`,
// the class the dashboard stack declares.
import {
  WibDate,
  encodeRecordedDay,
  recordedDayRequest,
  type RecordedDay,
  type StockCode,
} from "@workspace/relay"
import {
  WorkerEnv,
  runServerEffect,
  runServerEffectResult,
} from "@workspace/server"
import { DateTime, Effect, Layer, Option, Schema, Scope } from "effect"

import { durableSql } from "./durable-sql.ts"
import { marketClockOffset, withMarketClock } from "./market-clock.ts"
import type { CodeListStore } from "./code-list.ts"
import { respond } from "./respond.ts"
import {
  DAY_INDEX,
  DayIndexPath,
  HeldSessions,
  ObjectPath,
  ViewerHeader,
} from "./routes.ts"
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

// The sealed day's row, to the index Durable Object.
const recordDay = Effect.fnUntraced(function* (day: RecordedDay) {
  const env = yield* WorkerEnv
  const index = env.MARKET_LIVE_INDEX.getByName(DAY_INDEX)
  const body = yield* encodeRecordedDay(day)
  const response = yield* Effect.tryPromise(() =>
    index.fetch(new URL(DayIndexPath, "https://day-index.invalid"), {
      method: "POST",
      body,
    })
  )
  if (!response.ok)
    return yield* Effect.fail(new Error(`Index answered ${response.status}`))
})

// Decision: a plain class, not `DurableObject` from `cloudflare:workers`: the
// object needs no RPC, and only the bridge may import that module. Each
// callback runs through the bridge's result runner, which logs any failure.
export class TradingDayObject {
  private day!: Effect.Success<ReturnType<typeof makeTradingDay>>

  constructor(
    private readonly ctx: DurableObjectState,
    // Decision: the bindings Cloudflare hands the constructor serve only the
    // object's start, which runs before any request: the market clock and
    // its offset for the seal's alarm. Callbacks read WorkerEnv per request.
    env: WorkerEnv["Service"]
  ) {
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
    const workerEnv = Layer.succeed(WorkerEnv)(env)
    // The alarm runs on the Worker's clock; the seal on Market Live's.
    const start = Effect.gen(function* () {
      const offset = yield* marketClockOffset
      return yield* withMarketClock(
        makeTradingDay({
          date,
          viewers,
          viewersOf,
          ingests,
          codeList: codeListStore(ctx.storage),
          sql: durableSql(ctx.storage),
          setAlarm: (at) =>
            Effect.sync(
              () =>
                void ctx.storage.setAlarm(DateTime.toEpochMillis(at) - offset)
            ),
          recordDay,
        })
      )
    })
    // Cloudflare holds every event until the day is made; a failure resets
    // the object.
    void ctx.blockConcurrencyWhile(() =>
      runServerEffect(
        start.pipe(Scope.provide(scope), Effect.provide(workerEnv))
      ).then((day) => {
        this.day = day
      })
    )
  }

  // Accepts the socket the Worker entry routed here, already gated; answers
  // the sessions a user still holds (live-viewers.ts) and the recorded day
  // GETs, also gated.
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const recorded = Effect.runSync(recordedDayRequest(url))
    if (Option.isSome(recorded))
      return this.answer(this.day.recorded(recorded.value.resource))
    // The runner logs any failure.
    if (pathname === ObjectPath.endSessions)
      return respond(
        Effect.promise(() => request.json()).pipe(
          Effect.flatMap(decodeHeld),
          Effect.flatMap(this.day.endSessions),
          Effect.as(new Response(null, { status: 204 }))
        )
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

  private answer(response: Effect.Effect<Response, unknown, WorkerEnv>) {
    return respond(withMarketClock(response))
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

  // A viewer closing takes its codes out of the on-demand set; a relay closing
  // may leave the object with none: relay offline.
  webSocketClose(socket: WebSocket) {
    const tags = this.ctx.getTags(socket)
    if (tags.includes(VIEWER))
      return runServerEffectResult(
        withMarketClock(this.day.viewerClosed(peerOf(socket)))
      )
    if (!tags.includes(INGEST)) return undefined
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

  // Set for the seal, 17:00 WIB (trading-day.ts `alarm`).
  alarm() {
    return runServerEffectResult(withMarketClock(this.day.alarm))
  }
}
