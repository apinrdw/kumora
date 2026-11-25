import {
  MarketLivePath,
  ViewerCloseCode,
  decodeViewerDown,
  encodeViewerUp,
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

import { DashboardBasePath } from "./base-path.ts"

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

// The closes the page never reconnects after: 4401 and 4426.
const isTerminal = Schema.is(Schema.Union([SignInRequired, NewVersion]))

// Decision: any close but 4401 and 4426 reconnects and resumes from a snapshot
// (packages/client/docs/adr/0001-viewer-sockets-reconnect-on-any-close-but-4401-and-4426.md)
const reconnect = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("10 seconds"),
])

// The viewer socket on the page's own host, under the dashboard base path.
const liveSocketUrl = Effect.sync(() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws"
  return `${scheme}://${window.location.host}${DashboardBasePath}${MarketLivePath.live}`
})

// Market Live's viewer socket as a Stream of what the trading-day Durable
// Object sends: a snapshot on every (re)connect, then deltas. It sends the
// current `select` on each connect and again on every change, each answered
// with a fresh snapshot, and fails only on a terminal close. `onReconnecting`
// runs each time a connection drops and another will be tried.
export const viewerMessages = (options: {
  readonly select: SubscriptionRef.SubscriptionRef<ViewerUp>
  readonly onReconnecting?: Effect.Effect<void>
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
      const socket = yield* Socket.makeWebSocket(yield* liveSocketUrl)
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
        Effect.tapError((error) =>
          isTerminal(error)
            ? Effect.void
            : (options.onReconnecting ?? Effect.void)
        ),
        Effect.retry({
          while: (error) => !isTerminal(error),
          schedule: reconnect,
        }),
        Effect.catchTags({
          SocketError: Effect.die,
          SchemaError: Effect.die,
        })
      )
    })
  )
