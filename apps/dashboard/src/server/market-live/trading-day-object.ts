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

import { brokerTotalsDbD1 } from "../broker-totals/db.ts"
import { durableSql } from "./durable-sql.ts"
import { marketClockOffset, withMarketClock } from "./market-clock.ts"
import type { CodeListStore } from "./code-list.ts"
import { coldDay, type ColdDay } from "./cold-days.ts"
import { pokeDay, postToIndex, stripDays } from "./day-calls.ts"
import { respond } from "./respond.ts"
import {
  AccountId,
  DayIndexColdPath,
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
// id, not in the socket's attachment: an attachment holds 16,384 bytes, about
// 2,300 codes, and a Select past it would throw after the snapshot. A storage
// value holds 8 MB; a viewer's codes stay under 200 KB (envelope.test.ts).
// See apinrdw/kumora#157.
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
const makePeer = Effect.fnUntraced(function* (
  ctx: DurableObjectState,
  watching: WatchingStore,
  socket: WebSocket
) {
  const tags = ctx.getTags(socket)
  const id = yield* tagValue(tags, SOCKET)
  const isOpen = () => socket.readyState === WebSocket.OPEN
  const peer: Peer = {
    send: (text) =>
      Effect.sync(() => {
        if (isOpen()) socket.send(text)
      }),
    close: (code, reason) =>
      Effect.sync(() => {
        if (isOpen()) socket.close(code, reason)
      }),
    open: Effect.sync(isOpen),
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

// One Peer per socket for as long as the object is awake, so the day can
// tell the closing socket from the others it lists (trading-day.ts
// `ingestClosed`). Hibernation empties it; a peer reads its state from the
// socket, so a rebuilt one is the same. A peer built while another call
// built one for the same socket gives way to the one already kept.
const peerLookup = (ctx: DurableObjectState, watching: WatchingStore) =>
  Effect.sync(() => {
    const peers = new WeakMap<WebSocket, Peer>()
    return (socket: WebSocket) =>
      Effect.suspend(() => {
        const cached = peers.get(socket)
        if (cached !== undefined) return Effect.succeed(cached)
        return Effect.map(makePeer(ctx, watching, socket), (built) => {
          const kept = peers.get(socket)
          if (kept !== undefined) return kept
          peers.set(socket, built)
          return built
        })
      })
  })

type PeerLookup = Effect.Success<ReturnType<typeof peerLookup>>

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

// The sealed day's row, to the index Durable Object; one it refuses fails
// the seal, which retries.
const recordDay = (day: RecordedDay) =>
  Effect.flatMap(encodeRecordedDay(day), (body) =>
    postToIndex(DayIndexPath, body)
  )

// Whether the day index lists `date`.
const listed = (date: WibDate) =>
  Effect.map(stripDays, (days) => days.some((row) => row.day === date))

// The one storage key an emptied object keeps: its day moved to R2.
const COLD = "cold"

// Empties the object's storage and keeps the cold mark.
// Decision: deleteAll() and the mark's put go out with no await between
// them, so the output gate writes them as one: a restart finds either the
// day whole or the mark. The alarm goes first, so nothing wakes the emptied
// object. See spec apinrdw/kumora#556, "The move".
const emptied = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  yield* Effect.promise(() => storage.deleteAlarm())
  const [deleted, marked] = yield* Effect.sync(
    () => [storage.deleteAll(), storage.put(COLD, true)] as const
  )
  yield* Effect.promise(() => deleted)
  yield* Effect.promise(() => marked)
})

// Decision: a plain class, not `DurableObject` from `cloudflare:workers`: the
// object needs no RPC, and only the bridge may import that module. Each
// callback runs through the bridge's result runner, which logs any failure.
export class TradingDayObject {
  private day!: Effect.Success<ReturnType<typeof makeTradingDay>>
  private peerFor!: PeerLookup
  // An emptied object's answers, its day moved to R2; none while it is hot.
  private cold: ColdDay | undefined

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
      const peerFor = yield* peerLookup(ctx, yield* watchingStore(ctx.storage))
      const viewers = Effect.suspend(() =>
        Effect.forEach(ctx.getWebSockets(VIEWER), peerFor)
      )
      const viewersOf = (userId: AccountId) =>
        Effect.suspend(() =>
          Effect.forEach(
            ctx.getWebSockets(`${USER}${userId}`),
            Effect.fnUntraced(function* (socket) {
              const sessionId = yield* tagValue(ctx.getTags(socket), SESSION)
              return {
                peer: yield* peerFor(socket),
                sessionId:
                  sessionId === undefined
                    ? undefined
                    : SessionId.make(sessionId),
              }
            })
          )
        )
      const ingests = Effect.suspend(() =>
        Effect.forEach(ctx.getWebSockets(INGEST), peerFor)
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
          brokerTotalsDb: brokerTotalsDbD1,
          cold: {
            bucket: env.DAYS_BUCKET,
            markCold: postToIndex(DayIndexColdPath, date),
            empty: emptied(ctx.storage),
            listed,
            askMove: pokeDay(ObjectPath.move),
            anyHour: env.MARKET_LIVE_MOVES_ANY_HOUR !== undefined,
          },
        })
      )
      return { day, peerFor }
    })
    // An emptied object makes no day: its store is gone, and a day made on
    // it would make its tables again.
    const started = Effect.gen(function* () {
      if (
        (yield* Effect.promise(() => ctx.storage.get<boolean>(COLD))) === true
      )
        return { cold: coldDay(date, env.DAYS_BUCKET) }
      return yield* start
    })
    // Cloudflare holds every event until the day is made; a failure resets
    // the object.
    void ctx.blockConcurrencyWhile(() =>
      runServerEffect(
        started.pipe(Scope.provide(scope), Effect.provide(workerEnv))
      ).then((made) => {
        if ("cold" in made) this.cold = made.cold
        else {
          this.day = made.day
          this.peerFor = made.peerFor
        }
      })
    )
  }

  // An emptied object's answer: recorded day GETs from R2, a broker codes
  // batch taken but not written, the status as the move stored it; to a
  // poke (a session end, the reconcile cron's build, a move) nothing to do;
  // and no socket.
  private coldFetch(cold: ColdDay, request: Request, url: URL) {
    const recorded = Effect.runSync(recordedDayRequest(url))
    if (Option.isSome(recorded))
      return respond(cold.recorded(recorded.value.resource))
    if (url.pathname === ObjectPath.brokerCodes)
      return respond(
        request.method === "POST"
          ? Effect.flatMap(
              Effect.promise(() => request.text()),
              cold.post
            )
          : cold.status(url.searchParams)
      )
    const poked: ReadonlyArray<string> = [
      ObjectPath.endSessions,
      ObjectPath.brokerTotals,
      ObjectPath.move,
    ]
    return new Response(null, {
      status: poked.includes(url.pathname) ? 204 : 410,
    })
  }

  // Accepts the socket the Worker entry routed here, a viewer's already
  // gated and the relay's tagged with the instant on Market Live's clock its
  // token deadline counts from; answers the sessions a user still holds
  // (live-viewers.ts) and the recorded day GETs, also gated; and takes the
  // broker codes route's batches and status GETs, their token checked, and
  // the reconcile cron's pokes.
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url)
    if (this.cold !== undefined) return this.coldFetch(this.cold, request, url)
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
    if (pathname === ObjectPath.brokerCodes) {
      const { day } = this
      return respond(
        withMarketClock(
          request.method === "POST"
            ? Effect.flatMap(
                Effect.promise(() => request.text()),
                day.brokerCodes.post
              )
            : day.brokerCodes.status(new URL(request.url).searchParams)
        )
      )
    }
    // A newer day's seal, or the reconcile cron, asks the day to move.
    if (pathname === ObjectPath.move)
      return respond(
        withMarketClock(
          Effect.map(
            this.day.move,
            (moves) => new Response(null, { status: moves ? 202 : 204 })
          )
        )
      )
    // The reconcile cron's poke: 202 when the day will build, else 204.
    if (pathname === ObjectPath.brokerTotals)
      return respond(
        withMarketClock(
          Effect.map(
            this.day.brokerTotals.reconcile,
            (builds) => new Response(null, { status: builds ? 202 : 204 })
          )
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
    if (this.cold !== undefined) return socket.close(1001, "Day moved")
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message)
    const { day } = this
    const viewer = this.ctx.getTags(socket).includes(VIEWER)
    return runServerEffectResult(
      withMarketClock(
        Effect.flatMap(this.peerFor(socket), (peer) =>
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
    if (this.cold !== undefined) return undefined
    const tags = this.ctx.getTags(socket)
    if (tags.includes(VIEWER))
      return runServerEffectResult(
        withMarketClock(
          Effect.flatMap(this.peerFor(socket), this.day.viewerClosed)
        )
      )
    if (!tags.includes(INGEST)) return undefined
    return runServerEffectResult(
      withMarketClock(
        Effect.flatMap(this.peerFor(socket), this.day.ingestClosed)
      )
    )
  }

  webSocketError(socket: WebSocket) {
    return this.webSocketClose(socket)
  }

  // Set for the seal, 17:00 WIB, and its duties after it (trading-day.ts
  // `alarm`). An emptied object deleted its alarm.
  alarm() {
    if (this.cold !== undefined) return undefined
    return runServerEffectResult(withMarketClock(this.day.alarm))
  }
}
