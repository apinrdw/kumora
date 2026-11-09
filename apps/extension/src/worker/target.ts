// One target's ingest socket (spec apinrdw/kumora#138, "Batching and
// targets"). Each target runs on its own fiber and its own subscription to the
// envelopes, so a failing extra target never touches Production.
import {
  IngestCloseCode,
  IngestProtocolVersion,
  MarketLivePath,
  encodeIngestUp,
} from "@workspace/relay"
import { Duration, Effect, PubSub } from "effect"
import * as Socket from "effect/socket/Socket"

import type { DashboardOrigin, TargetState } from "./settings.ts"

// Decision: backoff starts at 1 s, doubles, and caps at 30 s; it resets once a
// socket opens, so a deploy during market hours costs one quick reconnect.
// 4403 and 4426 stop retrying until the target's settings change. See
// apinrdw/kumora#45.
const FIRST_RETRY = Duration.seconds(1)
const LAST_RETRY = Duration.seconds(30)

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
  readonly envelopes: PubSub.PubSub<string>
  readonly report: (state: TargetState) => Effect.Effect<void>
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
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      yield* writer.write(token)
      yield* opened
      // What comes down (backfill requests, on-demand codes) is read only to
      // notice a close until apinrdw/kumora#155 and #156 act on it.
      const read = Effect.forever(pull)
      const write = Effect.forever(
        Effect.flatMap(PubSub.take(envelopes), writer.write)
      )
      return yield* Effect.all([read, write], { concurrency: "unbounded" })
    }).pipe(Effect.scoped)

  let retry = FIRST_RETRY
  const opened = Effect.suspend(() => {
    retry = FIRST_RETRY
    return options.report("connected")
  })
  yield* options.report("connecting")
  while (true) {
    const error = yield* Effect.flip(connection(opened))
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
