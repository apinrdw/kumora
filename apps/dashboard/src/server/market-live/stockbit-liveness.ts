// Whether Stockbit's feed is live, for the Day state fallback. Time is read
// only through Effect's Clock.
import type { IngestUp } from "@workspace/relay"
import { Clock, Duration, Effect } from "effect"

// Spec apinrdw/kumora#138, "Feed freshness": live while a frame or ping reply
// arrived in the last 15 s.
const LIVE_FOR = Duration.toMillis(Duration.seconds(15))

// Decision: until the feed freshness ticket (apinrdw/kumora#149) lands, Day
// state reads Stockbit as live while a Stockbit frame or sign of life came in
// the last 15 s and the relay didn't report a Stockbit socket closed after
// it, ignoring the stretches that expect no trades. Its feed status replaces
// this module.
export const makeStockbitLiveness = Effect.sync(() => {
  let lastSign: number | undefined
  const ingest = Effect.fnUntraced(function* (message: IngestUp) {
    const stockbit =
      (message._tag === "Frames" || message._tag === "FeedStatus") &&
      message.feed === "Stockbit"
    if (!stockbit) return
    if (message._tag === "FeedStatus" && message.status === "closed")
      lastSign = undefined
    else lastSign = yield* Clock.currentTimeMillis
  })
  const live = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return lastSign !== undefined && now - lastSign < LIVE_FOR
  })
  return { ingest, live }
})
