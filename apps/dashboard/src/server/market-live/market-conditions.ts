// What every viewer of a trading day is told besides the tape: the market
// conditions (the market phase, each feed's freshness and the relay gaps)
// and the indicative prices (spec apinrdw/kumora#138, "Feed freshness" and
// "Indicative price"). Time is read only through Effect's Clock.
import {
  auctionAt,
  expectedStretches,
  marketMomentAt,
  nextOpenAfter,
  type IndicativePrice,
  type IngestUp,
  type MarketConditions,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeFeedHealth, type DownRecord } from "./feed-health.ts"
import { ajaibIndicative, stockbitIndicative } from "./indicative.ts"
import { newerThanHeld } from "./late-frames.ts"

// The phase at `now`, and when the market next opens while it is shut. A year
// past the baked schedule reads closed.
const phaseAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
  const moment = yield* marketMomentAt(now).pipe(
    Effect.catchTag("ScheduleYearMissing", () =>
      Effect.succeed({ phase: "closed" as const })
    )
  )
  const shut = moment.phase === "closed" || moment.phase === "holiday"
  const nextOpen = shut ? yield* nextOpenAfter(now) : undefined
  return nextOpen === undefined
    ? { phase: moment.phase }
    : { phase: moment.phase, nextOpen }
})

const sameIndicative = (a: IndicativePrice, b: IndicativePrice | undefined) =>
  Effect.succeed(
    b !== undefined &&
      a.price === b.price &&
      a.volume === b.volume &&
      DateTime.Equivalence(a.at, b.at)
  )

export const makeMarketConditions = Effect.fnUntraced(function* (
  date: WibDate,
  // The feeds' down stretches an object stored before it restarted.
  restored?: DownRecord
) {
  const stretches = yield* expectedStretches(date).pipe(
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed([]))
  )
  // Decision: the record of feed up and down stretches starts at the day's
  // midnight WIB. The trading day stores it with every flush, so an object
  // that restarts keeps the morning's record, and shows only the time from
  // its restart to the relay's next frame as down.
  const health = yield* makeFeedHealth({
    stretches,
    since: DateTime.makeUnsafe(`${date}T00:00:00+07:00`),
    ...(restored === undefined
      ? {}
      : { restored: { record: restored, at: yield* DateTime.now } }),
  })
  const stockbit = new Map<StockCode, IndicativePrice>()
  const ajaib = new Map<StockCode, IndicativePrice>()
  // What viewers were last sent per code, and the codes to look at again.
  const sent = new Map<StockCode, IndicativePrice>()
  const dirty = new Set<StockCode>()
  let stockbitLive = false

  const conditions = Effect.gen(function* () {
    const now = yield* DateTime.now
    const feeds = yield* health.conditionsAt(now)
    // A delayed Stockbit is still served until apinrdw/kumora#240.
    const live =
      feeds.feeds.Stockbit === "live" || feeds.feeds.Stockbit === "delayed"
    if (live !== stockbitLive) {
      // The fallback switches source for every code.
      stockbitLive = live
      for (const code of [...stockbit.keys(), ...ajaib.keys()]) dirty.add(code)
    }
    const market: MarketConditions = { ...(yield* phaseAt(now)), ...feeds }
    return market
  })

  // Decision: a code's indicative price is served only while the auction of
  // its time runs, by the clock here for every viewer: the prices are held all
  // day, and the morning's would otherwise come back at 15:50. The page applies
  // the same rule (`market-conditions.tsx`). Ajaib's price only while Stockbit
  // isn't live. See apinrdw/kumora#157.
  const indicativeOf = Effect.fnUntraced(function* (code: StockCode) {
    const running = yield* auctionAt(yield* DateTime.now)
    if (running === undefined) return undefined
    const current = Effect.fnUntraced(function* (
      store: Map<StockCode, IndicativePrice>
    ) {
      const held = store.get(code)
      if (held === undefined) return undefined
      const auction = yield* auctionAt(held.at)
      return auction?.date === running.date && auction.phase === running.phase
        ? held
        : undefined
    })
    return stockbitLive
      ? ((yield* current(stockbit)) ?? (yield* current(ajaib)))
      : ((yield* current(ajaib)) ?? (yield* current(stockbit)))
  })

  // Every code's indicative price that changed since the last call.
  const indicativeChanges = Effect.gen(function* () {
    yield* conditions
    const changed: Array<IndicativePrice> = []
    for (const code of dirty) {
      const current = yield* indicativeOf(code)
      if (
        current === undefined ||
        (yield* sameIndicative(current, sent.get(code)))
      )
        continue
      sent.set(code, current)
      changed.push(current)
    }
    dirty.clear()
    return changed
  })

  // Whether a code's indicative price may have changed since the last
  // indicativeChanges.
  const indicativePending = Effect.sync(() => dirty.size > 0)

  // A frame not newer than the price held, the other connection delivering
  // late, changes nothing.
  const keep = Effect.fnUntraced(function* (
    store: Map<StockCode, IndicativePrice>,
    prices: ReadonlyArray<IndicativePrice>
  ) {
    for (const price of prices) {
      if (!(yield* newerThanHeld(price.at, store.get(price.code)?.at))) continue
      store.set(price.code, price)
      dirty.add(price.code)
    }
  })

  // One envelope from a ready relay: a trade stream's frames and ping replies
  // are signs of life, a reported close takes that connection away. Ajaib's
  // on-demand frames answer a subscription and say nothing about its tape.
  const ingest = Effect.fnUntraced(function* (message: IngestUp) {
    const now = yield* DateTime.now
    yield* health.online
    if (message._tag === "Frames") {
      if (message.feed === "Stockbit" || message.stream === "trade")
        yield* health.sign(message.feed, message.connection, now)
      if (message.feed === "Stockbit")
        yield* keep(stockbit, yield* stockbitIndicative(date, message.frames))
      else yield* keep(ajaib, yield* ajaibIndicative(date, message.frames))
    }
    if (message._tag === "FeedStatus") {
      if (message.status === "alive")
        yield* health.sign(message.feed, message.connection, now)
      if (message.status === "closed")
        yield* health.closed(message.feed, message.connection, now)
    }
  })

  const relayOnline = health.online
  const relayOffline = Effect.flatMap(DateTime.now, health.offline)

  return {
    record: health.record,
    ingest,
    timed: health.timed,
    relayOnline,
    relayOffline,
    conditions,
    indicativeOf,
    indicativeChanges,
    indicativePending,
  }
})
