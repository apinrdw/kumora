// What every viewer of a trading day is told besides the tape: the market
// phase, each feed's freshness, the relay gaps and the indicative prices
// (spec apinrdw/kumora#138, "Feed freshness" and "Indicative price"). Time is
// read only through Effect's Clock.
import {
  WibDate,
  expectedStretches,
  isTradingDay,
  marketMomentAt,
  type IndicativePrice,
  type IngestUp,
  type MarketStatus,
  type StockCode,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeFeedHealth, type DownRecord } from "./feed-health.ts"
import { ajaibIndicative, stockbitIndicative } from "./indicative.ts"

// The market opens with pre-opening, 08:45 WIB.
const OPENS_AT = "08:45:00"

// The next trading day's opening after `now`, looking up to a month ahead.
// Undefined past the baked schedule.
const nextOpenAfter = Effect.fnUntraced(
  function* (now: DateTime.Utc) {
    for (let days = 0; days <= 31; days++) {
      const date = WibDate.make(
        DateTime.formatIsoDate(DateTime.add(now, { hours: 7, days }))
      )
      const open = DateTime.makeUnsafe(`${date}T${OPENS_AT}+07:00`)
      if (DateTime.Order(open, now) <= 0) continue
      if (yield* isTradingDay(date)) return open
    }
    return undefined
  },
  Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(undefined))
)

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
  b !== undefined &&
  a.price === b.price &&
  a.volume === b.volume &&
  DateTime.Equivalence(a.at, b.at)

export const makeMarketStatus = Effect.fnUntraced(function* (
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

  const status = Effect.gen(function* () {
    const now = yield* DateTime.now
    const feeds = yield* health.status(now)
    const live = feeds.feeds.Stockbit === "live"
    if (live !== stockbitLive) {
      // The fallback switches source for every code.
      stockbitLive = live
      for (const code of [...stockbit.keys(), ...ajaib.keys()]) dirty.add(code)
    }
    const market: MarketStatus = { ...(yield* phaseAt(now)), ...feeds }
    return market
  })

  // Ajaib's indicative price only while Stockbit isn't live.
  const indicativeOf = (code: StockCode) =>
    Effect.sync(() =>
      stockbitLive
        ? (stockbit.get(code) ?? ajaib.get(code))
        : (ajaib.get(code) ?? stockbit.get(code))
    )

  // Every code's indicative price that changed since the last call.
  const indicativeChanges = Effect.gen(function* () {
    yield* status
    const changed: Array<IndicativePrice> = []
    for (const code of dirty) {
      const current = yield* indicativeOf(code)
      if (current === undefined || sameIndicative(current, sent.get(code)))
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

  const keep = (
    store: Map<StockCode, IndicativePrice>,
    prices: ReadonlyArray<IndicativePrice>
  ) => {
    for (const price of prices) {
      store.set(price.code, price)
      dirty.add(price.code)
    }
  }

  // One envelope from a ready relay: frames and ping replies are signs of
  // life, a reported close takes that connection away.
  const ingest = Effect.fnUntraced(function* (message: IngestUp) {
    const now = yield* DateTime.now
    yield* health.online
    if (message._tag === "Frames") {
      yield* health.sign(message.feed, message.connection, now)
      if (message.feed === "Stockbit")
        keep(stockbit, yield* stockbitIndicative(message.frames))
      else keep(ajaib, yield* ajaibIndicative(message.frames))
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
    relayOnline,
    relayOffline,
    status,
    indicativeOf,
    indicativeChanges,
    indicativePending,
  }
})
