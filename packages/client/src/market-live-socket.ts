import {
  TradeNumberOrder,
  ViewerCloseCode,
  decodeViewerDown,
  encodeViewerUp,
  type RunningTrade,
  type ViewerDown,
  type ViewerUp,
} from "@workspace/relay"
import {
  Effect,
  Queue,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import * as Socket from "effect/socket/Socket"

// The viewer socket closed with 4401: the page sends the visitor to sign in.
export class SignInRequired extends Schema.TaggedError<SignInRequired>()(
  "SignInRequired",
  {}
) {}

// The viewer socket closed with 4426: the page runs an older protocol version
// than the Worker, and must reload.
export class NewVersion extends Schema.TaggedError<NewVersion>()(
  "NewVersion",
  {}
) {}

// Decision: any close but 4401 and 4426 reconnects, with backoff capped at
// 10 s, and the page resumes from the fresh snapshot the new socket sends (spec
// apinrdw/kumora#138, "The viewer protocol").
const reconnect = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("10 seconds"),
])

// Market Live's viewer socket as a Stream of what the trading-day Durable
// Object sends: a snapshot on every (re)connect, then deltas. It sends the
// current `select` on each connect and again on every change, each answered
// with a fresh snapshot, and fails only on a terminal close.
export const viewerMessages = (options: {
  readonly url: string
  readonly select: SubscriptionRef.SubscriptionRef<ViewerUp>
}): Stream.Stream<
  ViewerDown,
  SignInRequired | NewVersion,
  Socket.WebSocketConstructor
> =>
  Stream.callback<
    ViewerDown,
    SignInRequired | NewVersion,
    Socket.WebSocketConstructor
  >((queue) =>
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(options.url)
      const connection = Effect.gen(function* () {
        const pull = yield* Socket.readerString(socket)
        const writer = yield* socket.writer
        // The current value first, then each change. A write that fails ends
        // with the socket, which the reader reports.
        yield* SubscriptionRef.changes(options.select).pipe(
          Stream.runForEach((select) =>
            Effect.orDie(encodeViewerUp(select)).pipe(
              Effect.flatMap((text) => writer.write(text))
            )
          ),
          Effect.ignore,
          Effect.forkScoped
        )
        while (true) {
          for (const text of yield* pull)
            Queue.offerUnsafe(queue, yield* decodeViewerDown(text))
        }
      }).pipe(Effect.scoped)
      return yield* connection.pipe(
        Effect.mapError((error) => {
          if (
            !Socket.isSocketError(error) ||
            error.reason._tag !== "SocketCloseError"
          )
            return error
          if (error.reason.code === ViewerCloseCode.SignInRequired)
            return new SignInRequired()
          if (error.reason.code === ViewerCloseCode.NewVersion)
            return new NewVersion()
          return error
        }),
        Effect.retry({
          while: (error) =>
            !(error instanceof SignInRequired || error instanceof NewVersion),
          schedule: reconnect,
        }),
        Effect.catchTags({
          SocketError: Effect.die,
          SchemaError: Effect.die,
        })
      )
    })
  )

// The tape a page keeps: newest first, at most this many trades.
const TAPE_CAP = 10_000

// The page's tape after one viewer message. A snapshot replaces it; a delta's
// trades go in by trade number, so a late one lands in its place.
export const applyViewerMessage = Effect.fnUntraced(function* (
  tape: ReadonlyArray<RunningTrade>,
  message: ViewerDown
) {
  const arriving = new Set(message.tape.map((trade) => trade.tradeNumber))
  const known =
    message._tag === "Snapshot"
      ? []
      : tape.filter((trade) => !arriving.has(trade.tradeNumber))
  return [...known, ...message.tape]
    .sort((a, b) => TradeNumberOrder(b.tradeNumber, a.tradeNumber))
    .slice(0, TAPE_CAP)
})
