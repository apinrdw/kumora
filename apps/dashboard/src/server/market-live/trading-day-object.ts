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
import { Clock, DateTime, Effect, Layer, Option, Schema, Scope } from "effect"

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
// storage. An ingest socket carries when it was accepted, so one that never
// sends its token is closed (trading-day.ts). Tags outlive hibernation.
const INGEST = "ingest"
const ACCEPTED = "accepted:"
const VIEWER = "viewer"
const USER = "user:"
const SESSION = "session:"
const SESSION_END = "session-end:"
const SOCKET = "socket:"

const decodeSessionEnd = Schema.decodeUnknownOption(SessionEnd)
const decodeAccepted = Schema.decodeUnknownOption(Schema.FiniteFromString)

const tagValue = (tags: ReadonlyArray<string>, prefix: string) =>
  Effect.sync(() => {
    const tag = tags.find((each) => each.startsWith(prefix))
    return tag === undefined ? undefined : tag.slice(prefix.length)
  })

// A viewer's session end from its tags; none for a socket tagged without
// one, which is served nothing.
const sessionEndOf = Effect.fnUntraced(function* (tags: ReadonlyArray<string>) {
  const end = yield* tagValue(tags, SESSION_END)
  return end === undefined
    ? undefined
    : Option.getOrUndefined(decodeSessionEnd(end))
})

// When an ingest socket was accepted, from its tags; none for a socket
// tagged without it.
const acceptedOf = Effect.fnUntraced(function* (tags: ReadonlyArray<string>) {
  const at = yield* tagValue(tags, ACCEPTED)
  return at === undefined
    ? undefined
    : Option.getOrUndefined(decodeAccepted(at))
})

// A socket's attachment survives hibernation: its state. A socket without
// one is new.
const stateOf = (socket: WebSocket) =>
  Effect.sync(
    () => (socket.deserializeAttachment() as PeerState | null) ?? "new"
  )

const WATCHING = "watching:"

// Decision: a viewer's codes live in the object's storage under its socket's
// id, not in the socket's attachment: an attachment holds 16,384 bytes
// (Cloudflare's documented limit for `serializeAttachment`,
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/,
// and what workerd 1.20261026.1 enforces),
// about 2,300 four-character codes, and a Select past it would throw after
// the snapshot, leaving the page connected but off the on-demand set. The
// storage is SQLite-backed (the day store runs SQL on it), and holds a key
// and its value together up to 8 MB (Cloudflare's Durable Objects limits
// page, https://developers.cloudflare.com/durable-objects/platform/limits/, read
// 2026-11-10): a Select's watchlist is capped at 10,000 codes and a code at
// 16 characters at decode (envelope.ts, codes.ts), so a viewer's codes stay
// under 200 KB, as envelope.test.ts measures. A read is kept in
// memory, so a delta's read of every viewer's codes is free after the first
// since the object woke. A socket's codes leave storage when it closes; an
// object reset that skips the close callback leaves a few bytes nothing
// reads.
const watchingStore = (storage: DurableObjectStorage) =>
  Effect.sync(() => {
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
  })

type WatchingStore = Effect.Success<ReturnType<typeof watchingStore>>

// A socket already closing, which a delta can still find listed, takes
// neither a send nor a second close. A viewer's codes are read and written
// under its id tag; an ingest socket has no id, and no codes.
const peerOf = Effect.fnUntraced(function* (
  ctx: DurableObjectState,
  watching: WatchingStore,
  socket: WebSocket
) {
  const tags = ctx.getTags(socket)
  const id = yield* tagValue(tags, SOCKET)
  const peer: Peer = {
    send: (text) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text)
      }),
    close: (code, reason) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      }),
    state: stateOf(socket),
    setState: (state) => Effect.sync(() => socket.serializeAttachment(state)),
    ...(id === undefined
      ? {}
      : {
          watching: watching.read(id),
          setWatching: (codes: ReadonlyArray<StockCode>) =>
            watching.write(id, codes),
        }),
    sessionEnd: sessionEndOf(tags),
    accepted: acceptedOf(tags),
  }
  return peer
})

const decodeDate = Schema.decodeUnknownSync(WibDate)
const decodeAccount = Schema.decodeUnknownOption(AccountId)
const decodeSession = Schema.decodeUnknownOption(SessionId)

// A gated viewer socket's tags, from the headers the entry set and a fresh
// id; none when any header is missing.
const viewerTags = Effect.fnUntraced(function* (request: Request) {
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
        `${USER}${userId.value}`,
        `${SESSION}${sessionId.value}`,
        `${SESSION_END}${sessionEnd.value}`,
        `${SOCKET}${yield* Effect.sync(() => crypto.randomUUID())}`,
      ]
    : undefined
})
const decodeHeld = Schema.decodeUnknownEffect(HeldSessions)

const CODE_LIST_KEY = "code-list"

const codeListStore = (storage: DurableObjectStorage) =>
  Effect.succeed<CodeListStore>({
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
  private watching!: WatchingStore

  constructor(
    private readonly ctx: DurableObjectState,
    // Decision: the bindings Cloudflare hands the constructor serve only the
    // object's start, which runs before any request: the market clock and
    // its offset for the seal's alarm. Callbacks read WorkerEnv per request.
    env: WorkerEnv["Service"]
  ) {
    // The Worker entry reaches the object by name, so the name is set.
    const date = decodeDate(ctx.id.name)
    // Lives as long as the object; it holds the delta timers.
    const scope = Scope.makeUnsafe()
    const workerEnv = Layer.succeed(WorkerEnv)(env)
    // The alarm runs on the Worker's clock; the seal on Market Live's.
    const start = Effect.gen(function* () {
      const watching = yield* watchingStore(ctx.storage)
      const peer = (socket: WebSocket) => peerOf(ctx, watching, socket)
      const viewers = Effect.suspend(() =>
        Effect.forEach(ctx.getWebSockets(VIEWER), peer)
      )
      const viewersOf = (userId: AccountId) =>
        Effect.suspend(() =>
          Effect.forEach(
            ctx.getWebSockets(`${USER}${userId}`),
            Effect.fnUntraced(function* (socket) {
              const sessionId = yield* tagValue(ctx.getTags(socket), SESSION)
              return {
                peer: yield* peer(socket),
                sessionId:
                  sessionId === undefined
                    ? undefined
                    : SessionId.make(sessionId),
              }
            })
          )
        )
      const ingests = Effect.suspend(() =>
        Effect.forEach(ctx.getWebSockets(INGEST), peer)
      )
      const offset = yield* marketClockOffset
      const day = yield* withMarketClock(
        makeTradingDay({
          date,
          viewers,
          viewersOf,
          ingests,
          codeList: yield* codeListStore(ctx.storage),
          sql: yield* durableSql(ctx.storage),
          setAlarm: (at) =>
            Effect.sync(
              () =>
                void ctx.storage.setAlarm(DateTime.toEpochMillis(at) - offset)
            ),
          recordDay,
        })
      )
      return { day, watching }
    })
    // Cloudflare holds every event until the day is made; a failure resets
    // the object.
    void ctx.blockConcurrencyWhile(() =>
      runServerEffect(
        start.pipe(Scope.provide(scope), Effect.provide(workerEnv))
      ).then(({ day, watching }) => {
        this.day = day
        this.watching = watching
      })
    )
  }

  // Accepts the socket the Worker entry routed here, a viewer's already
  // gated and the relay's tagged with the instant on Market Live's clock its
  // token deadline counts from; answers the sessions a user still holds
  // (live-viewers.ts) and the recorded day GETs, also gated.
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const recorded = Effect.runSync(recordedDayRequest(url))
    if (Option.isSome(recorded))
      return respond(
        withMarketClock(this.day.recorded(recorded.value.resource))
      )
    // The runner logs any failure.
    if (pathname === ObjectPath.endSessions)
      return respond(
        Effect.promise(() => request.json()).pipe(
          Effect.flatMap(decodeHeld),
          Effect.flatMap(this.day.endSessions),
          Effect.as(new Response(null, { status: 204 }))
        )
      )
    if (pathname === ObjectPath.ingest) {
      const { ctx, day } = this
      return respond(
        withMarketClock(
          Effect.gen(function* () {
            const accepted = yield* Clock.currentTimeMillis
            const pair = new WebSocketPair()
            ctx.acceptWebSocket(pair[1], [INGEST, `${ACCEPTED}${accepted}`])
            yield* day.ingestOpened
            return new Response(null, { status: 101, webSocket: pair[0] })
          })
        )
      )
    }
    // Pure and synchronous: the tags from the request's headers and a fresh
    // id.
    const tags = Effect.runSync(viewerTags(request))
    // The entry always names the viewer's account, session and its end.
    if (tags === undefined)
      return new Response("Viewer not named", { status: 400 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], tags)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message)
    const { day } = this
    const viewer = this.ctx.getTags(socket).includes(VIEWER)
    return runServerEffectResult(
      withMarketClock(
        Effect.flatMap(peerOf(this.ctx, this.watching, socket), (peer) =>
          viewer ? day.viewerMessage(peer, text) : day.ingestMessage(peer, text)
        )
      )
    )
  }

  // A viewer closing takes its codes out of the on-demand set; a ready relay
  // socket closing may leave the object with no ready one: relay offline.
  // Both the closing socket's state and the others' are read from their
  // attachments, so the first event after hibernation decides the same way.
  webSocketClose(socket: WebSocket) {
    const tags = this.ctx.getTags(socket)
    if (tags.includes(VIEWER))
      return runServerEffectResult(
        withMarketClock(
          Effect.flatMap(
            peerOf(this.ctx, this.watching, socket),
            this.day.viewerClosed
          )
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
    const { day } = this
    return runServerEffectResult(
      withMarketClock(
        Effect.flatMap(peerOf(this.ctx, this.watching, socket), (peer) =>
          day.ingestClosed(peer, remaining)
        )
      )
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
