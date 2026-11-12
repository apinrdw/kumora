// One target's ingest socket (spec apinrdw/kumora#138, "Batching and
// targets"). Each target runs on its own fiber and its own subscription to the
// envelopes, so a failing extra target never touches Production.
import {
  IngestCloseCode,
  IngestProtocolVersion,
  MarketLivePath,
  decodeIngestDown,
  encodeIngestUp,
  type EncodedIngestUp,
  type IngestDown,
  type WibDate,
} from "@workspace/relay"
import {
  Duration,
  Effect,
  PubSub,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import * as Socket from "effect/socket/Socket"

import type { DashboardOrigin, TargetState } from "./settings.ts"

// Decision: backoff starts at 1 s, doubles, and caps at 30 s; it resets once a
// socket opens, so a deploy during streaming hours costs one quick reconnect.
// 4403 and 4426 stop retrying until the target's settings change. See
// apinrdw/kumora#45.
const FIRST_RETRY = Duration.seconds(1)
const LAST_RETRY = Duration.seconds(30)

// The WIB date moved on while the socket was open.
class DayChanged extends Schema.TaggedError<DayChanged>()("DayChanged", {}) {}

const ingestUrl = Effect.fnUntraced(function* (origin: DashboardOrigin) {
  return `${origin.replace(/^http/, "ws")}${MarketLivePath.ingest}`
})

// Holds the target's ingest socket open and sends it every envelope published
// while it is open; envelopes from while it is down are dropped, and the
// trading-day object's backfill fills the gap. It returns only on a terminal
// close.
export const runTarget = Effect.fnUntraced(function* (options: {
  readonly origin: DashboardOrigin
  readonly token: string
  readonly envelopes: PubSub.PubSub<EncodedIngestUp>
  // Today's WIB date on the relay's schedule clock.
  // Decision: the socket reopens as soon as the date changes, since the
  // dashboard picks the trading-day object by WIB date at the handshake. Its
  // day is read before it dials: read after, a date that moved mid-handshake
  // would keep a socket on the old day's object a day. See apinrdw/kumora#157.
  readonly day: SubscriptionRef.SubscriptionRef<WibDate>
  // What every fresh socket is sent after the token: the socket's day's code
  // list, which a target that was down for the daily fetch would otherwise
  // miss.
  readonly catchUp: (
    day: WibDate
  ) => Effect.Effect<ReadonlyArray<EncodedIngestUp>>
  readonly report: (state: TargetState) => Effect.Effect<void>
  // What the trading-day object sends down: on-demand codes and backfill
  // requests.
  readonly receive: (message: IngestDown) => Effect.Effect<void>
}) {
  const url = yield* ingestUrl(options.origin)
  const token = yield* encodeIngestUp({
    _tag: "Token",
    protocolVersion: IngestProtocolVersion,
    token: options.token,
  })

  const connection = (opened: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(url)
      const envelopes = yield* PubSub.subscribe(options.envelopes)
      const day = yield* SubscriptionRef.get(options.day)
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      yield* writer.write(token)
      for (const text of yield* options.catchUp(day)) yield* writer.write(text)
      yield* opened
      // A message that doesn't decode is dropped: it may be from a newer
      // dashboard, which closes 4426 if the versions really differ.
      const read = Effect.forever(
        pull.pipe(
          Effect.flatMap((texts) =>
            Effect.forEach(
              texts,
              (text) =>
                Effect.matchEffect(decodeIngestDown(text), {
                  onFailure: () => Effect.void,
                  onSuccess: options.receive,
                }),
              { discard: true }
            )
          )
        )
      )
      const write = Effect.forever(
        Effect.flatMap(PubSub.take(envelopes), writer.write)
      )
      // `changes` replays the current date, so a change since `day` was read
      // is seen here too.
      const untilNextDay = SubscriptionRef.changes(options.day).pipe(
        Stream.filter((current) => current !== day),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.fail(new DayChanged()))
      )
      return yield* Effect.all([read, write, untilNextDay], {
        concurrency: "unbounded",
      })
    }).pipe(Effect.scoped)

  let retry = FIRST_RETRY
  const opened = Effect.suspend(() => {
    retry = FIRST_RETRY
    return options.report("connected")
  })
  yield* options.report("connecting")
  while (true) {
    const error = yield* Effect.flip(connection(opened))
    if (error._tag === "DayChanged") {
      yield* options.report("connecting")
      continue
    }
    const code =
      error.reason._tag === "SocketCloseError" ? error.reason.code : undefined
    if (code === IngestCloseCode.RejectedToken)
      return yield* options.report("rejected-token")
    if (code === IngestCloseCode.VersionMismatch)
      return yield* options.report("reload-extension")
    yield* options.report("retrying")
    yield* Effect.sleep(retry)
    retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
  }
})
