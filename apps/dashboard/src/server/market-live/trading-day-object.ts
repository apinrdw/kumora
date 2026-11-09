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
  AccountId,
  DAY_INDEX,
  DayIndexPath,
  HeldSessions,
  ObjectPath,
  SessionEnd,
  SessionId,
  ViewerHeader,
} from "./routes.ts"
import { makeTradingDay, type Peer, type PeerState } from "./trading-day.ts"

// Socket tags. A viewer socket also carries its user and session, so a ban or
// revoke can close it (apinrdw/kumora#144), its session's end, so an expired
// one is closed (trading-day.ts), and its own id, which keys its codes in
// storage. Tags outlive hibernation.
const INGEST = "ingest"
const VIEWER = "viewer"
const userTag = (userId: AccountId) => `user:${userId}`
const SESSION = "session:"
const sessionTag = (sessionId: SessionId) => `${SESSION}${sessionId}`
const SESSION_END = "session-end:"
const sessionEndTag = (end: number) => `${SESSION_END}${end}`
const SOCKET = "socket:"
const socketTag = (id: string) => `${SOCKET}${id}`

const decodeSessionEnd = Schema.decodeUnknownOption(SessionEnd)

const tagValue = (tags: ReadonlyArray<string>, prefix: string) => {
  const tag = tags.find((each) => each.startsWith(prefix))
  return tag === undefined ? undefined : tag.slice(prefix.length)
}

// A viewer's session end from its tags; none for a socket tagged without
// one, which is served nothing.
const sessionEndOf = (tags: ReadonlyArray<string>) => {
  const end = tagValue(tags, SESSION_END)
  return end === undefined
    ? undefined
    : Option.getOrUndefined(decodeSessionEnd(end))
}

// A socket's attachment survives hibernation: its state. A socket without
// one is new.
const stateOf = (socket: WebSocket) =>
  (socket.deserializeAttachment() as PeerState | null) ?? "new"

const WATCHING = "watching:"

// Decision: a viewer's codes live in the object's storage under its socket's
// id, not in the socket's attachment: an attachment holds 16,384 bytes
// (Cloudflare's documented limit, and what workerd 1.20261026.1 enforces),
// about 2,300 four-character codes, and a Select past it would throw after
// the snapshot, leaving the page connected but off the on-demand set. The
// storage bounds nothing a Select can carry, and a read is kept in memory, so
// a delta's read of every viewer's codes is free after the first since the
// object woke. A socket's codes leave storage when it closes; an object reset
// that skips the close callback leaves a few bytes nothing reads.
const watchingStore = (storage: DurableObjectStorage) => {
  const held = new Map<string, ReadonlyArray<StockCode>>()
  const read = (id: string) =>
    Effect.suspend(() => {
      const cached = held.get(id)
      if (cached !== undefined) return Effect.succeed(cached)
      return Effect.promise(() =>
        storage.get<ReadonlyArray<StockCode>>(`${WATCHING}${id}`)
      ).pipe(
        Effect.map((stored) => {
          const codes = stored ?? []
          held.set(id, codes)
          return codes
        })
      )
    })
  const write = (id: string, codes: ReadonlyArray<StockCode>) => {
    const key = `${WATCHING}${id}`
    const stored =
      codes.length === 0
        ? Effect.promise(() => storage.delete(key))
        : Effect.promise(() => storage.put(key, codes))
    return Effect.andThen(
      stored,
      Effect.sync(() => {
        if (codes.length === 0) held.delete(id)
        else held.set(id, codes)
      })
    )
  }
  return { read, write }
}

type WatchingStore = ReturnType<typeof watchingStore>

// A socket already closing, which a delta can still find listed, takes
// neither a send nor a second close. A viewer's codes are read and written
// under its id tag; an ingest socket has no id, and no codes.
const peerOf = (
  ctx: DurableObjectState,
  watching: WatchingStore,
  socket: WebSocket
): Peer => {
  const tags = ctx.getTags(socket)
  const id = tagValue(tags, SOCKET)
  return {
    send: (text) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text)
      }),
    close: (code, reason) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      }),
    state: Effect.sync(() => stateOf(socket)),
    setState: (state) => Effect.sync(() => socket.serializeAttachment(state)),
    ...(id === undefined
      ? {}
      : {
          watching: watching.read(id),
          setWatching: (codes: ReadonlyArray<StockCode>) =>
            watching.write(id, codes),
        }),
    sessionEnd: Effect.sync(() => sessionEndOf(tags)),
  }
}

const decodeDate = Schema.decodeUnknownSync(WibDate)
const decodeAccount = Schema.decodeUnknownOption(AccountId)
const decodeSession = Schema.decodeUnknownOption(SessionId)

// A gated viewer socket's tags, from the headers the entry set and a fresh
// id; none when any header is missing.
const viewerTags = (request: Request) => {
  const userId = decodeAccount(request.headers.get(ViewerHeader.userId))
  const sessionId = decodeSession(request.headers.get(ViewerHeader.sessionId))
  const sessionEnd = decodeSessionEnd(
    request.headers.get(ViewerHeader.sessionEnd)
  )
  return Option.isSome(userId) &&
    Option.isSome(sessionId) &&
    Option.isSome(sessionEnd)
    ? [
        VIEWER,
        userTag(userId.value),
        sessionTag(sessionId.value),
        sessionEndTag(sessionEnd.value),
        socketTag(crypto.randomUUID()),
      ]
    : undefined
}
const decodeHeld = Schema.decodeUnknownEffect(HeldSessions)

const CODE_LIST_KEY = "code-list"

const codeListStore = (storage: DurableObjectStorage): CodeListStore => ({
  read: Effect.promise(() => storage.get<string>(CODE_LIST_KEY)).pipe(
    Effect.map(Option.fromUndefinedOr)
  ),
  write: (text) => Effect.promise(() => storage.put(CODE_LIST_KEY, text)),
})

// The index Durable Object didn't take a sealed day's row; the seal retries.
class IndexRefusedDay extends Schema.TaggedError<IndexRefusedDay>()(
  "IndexRefusedDay",
  { status: Schema.Int }
) {}

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
    return yield* new IndexRefusedDay({ status: response.status })
})

// Decision: a plain class, not `DurableObject` from `cloudflare:workers`: the
// object needs no RPC, and only the bridge may import that module. Each
// callback runs through the bridge's result runner, which logs any failure.
export class TradingDayObject {
  private day!: Effect.Success<ReturnType<typeof makeTradingDay>>
  private readonly watching: WatchingStore

  constructor(
    private readonly ctx: DurableObjectState,
    // Decision: the bindings Cloudflare hands the constructor serve only the
    // object's start, which runs before any request: the market clock and
    // its offset for the seal's alarm. Callbacks read WorkerEnv per request.
    env: WorkerEnv["Service"]
  ) {
    // The Worker entry reaches the object by name, so the name is set.
    const date = decodeDate(ctx.id.name)
    const watching = watchingStore(ctx.storage)
    this.watching = watching
    const peer = (socket: WebSocket) => peerOf(ctx, watching, socket)
    const viewers = Effect.sync(() => ctx.getWebSockets(VIEWER).map(peer))
    const viewersOf = (userId: AccountId) =>
      Effect.sync(() =>
        ctx.getWebSockets(userTag(userId)).map((socket) => {
          const sessionId = tagValue(ctx.getTags(socket), SESSION)
          return {
            peer: peer(socket),
            sessionId:
              sessionId === undefined ? undefined : SessionId.make(sessionId),
          }
        })
      )
    const ingests = Effect.sync(() => ctx.getWebSockets(INGEST).map(peer))
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
    const tags = pathname === ObjectPath.live ? viewerTags(request) : [INGEST]
    // The entry always names the viewer's account, session and its end.
    if (tags === undefined)
      return new Response("Viewer not named", { status: 400 })
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
    const peer = peerOf(this.ctx, this.watching, socket)
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
        withMarketClock(
          this.day.viewerClosed(peerOf(this.ctx, this.watching, socket))
        )
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
