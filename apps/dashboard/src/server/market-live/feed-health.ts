// Each feed's freshness and the day's relay gaps (spec apinrdw/kumora#138,
// "Feed freshness", and apinrdw/kumora#235, "Feed health"). Everything is
// decided from instants and lags the caller reads through Effect's Clock, so
// the tests drive it with TestClock.
import {
  type Connection,
  type Feed,
  type Freshness,
  type Interval,
  type RelayGap,
} from "@workspace/relay"
import { DateTime, Effect, Record as Records } from "effect"

import { percentile, type TimedTrade } from "./feed-lag.ts"

// Decision: a feed is stale after 15 s of silence and unavailable after 60 s,
// counted only inside stretches that expect trades, so the break and the
// auctions before their match never go stale. Ajaib's on-demand frames are no
// sign of life: they answer a subscription, not its tape (market-conditions.ts
// decides which frames count). See apinrdw/kumora#133.
const STALE_AFTER = 15_000
const UNAVAILABLE_AFTER = 60_000

// Decision: a feed is delayed while the median feed lag of its trades that
// arrived in the last 10 s is over 5 s, and live again once it is under 2 s.
// Stale and unavailable outrank it, and it opens no relay gap: frames still
// arrive. See apinrdw/kumora#235.
const LAG_WINDOW = 10_000
const DELAYED_OVER = 5_000
const LIVE_UNDER = 2_000
// Decision: a window needs 3 trades before its median can turn a feed
// delayed, so one slow batch after a quiet stretch doesn't (story 8). Clearing
// takes any reading. See apinrdw/kumora#235.
const DELAYED_MIN_TRADES = 3
// Decision: the lag viewers are told is rounded to whole seconds, so a lag
// moving by milliseconds doesn't resend the market conditions in every delta.
// The thresholds judge the unrounded median. See apinrdw/kumora#235.
const LAG_SHOWN_IN = 1_000

const FEEDS: ReadonlyArray<Feed> = ["Stockbit", "Ajaib"]

const millis = DateTime.toEpochMillis

// A stretch in which a feed was not live. The last may still be open.
type Down = { readonly from: DateTime.Utc; to: DateTime.Utc | undefined }

// Each feed's down stretches as epoch ms, the form a restarted object reads
// back (trading-day.ts stores it).
export type DownRecord = Record<
  Feed,
  ReadonlyArray<{ readonly from: number; readonly to?: number }>
>

interface Track {
  lastSign: DateTime.Utc | undefined
  // Connections that showed a sign of life and weren't reported closed since.
  readonly open: Set<Connection>
  readonly downs: Array<Down>
  // The feed lags of its timed trades, oldest arrival first, back to the lag
  // window.
  readonly lags: Array<Pick<TimedTrade, "arrived" | "lag">>
  // While the feed is delayed, its last reading rounded to LAG_SHOWN_IN.
  delayedBy: number | undefined
}

const newTrack = Effect.sync((): Track => ({
  lastSign: undefined,
  open: new Set(),
  downs: [],
  lags: [],
  delayedBy: undefined,
}))

// Decision: a lag window with no trades has no reading and keeps a feed's
// state, so a delayed feed that goes silent stays delayed, with its last lag,
// until stale takes over (stories 5 and 9). See apinrdw/kumora#235.
//
// Prunes a feed's lags to the window up to `now` (epoch ms) and judges by
// their median whether the feed is delayed.
const judgeLag = (track: Track, now: number) =>
  Effect.gen(function* () {
    const kept = track.lags.findIndex(
      (timed) => timed.arrived >= now - LAG_WINDOW
    )
    track.lags.splice(0, kept === -1 ? track.lags.length : kept)
    if (track.lags.length === 0) return
    const median = yield* percentile(
      track.lags.map((timed) => timed.lag).sort((a, b) => a - b),
      50
    )
    const delayed =
      median >= LIVE_UNDER &&
      (track.delayedBy !== undefined ||
        (median > DELAYED_OVER && track.lags.length >= DELAYED_MIN_TRADES))
    track.delayedBy = delayed
      ? Math.round(median / LAG_SHOWN_IN) * LAG_SHOWN_IN
      : undefined
  })

// The milliseconds of `stretches` between two instants.
const expectedBetween = (
  stretches: ReadonlyArray<Interval>,
  from: DateTime.Utc,
  to: DateTime.Utc
) =>
  Effect.sync(() =>
    stretches.reduce(
      (total, stretch) =>
        total +
        Math.max(
          0,
          Math.min(millis(to), millis(stretch.to)) -
            Math.max(millis(from), millis(stretch.from))
        ),
      0
    )
  )

// The instant `amount` ms of `stretches` have passed since `from`.
const afterExpected = (
  stretches: ReadonlyArray<Interval>,
  from: DateTime.Utc,
  amount: number
) =>
  Effect.sync(() => {
    let left = amount
    for (const stretch of stretches) {
      const start = Math.max(millis(from), millis(stretch.from))
      const available = millis(stretch.to) - start
      if (available <= 0) continue
      if (available >= left) return DateTime.makeUnsafe(start + left)
      left -= available
    }
    return undefined
  })

// Where two sorted lists of stretches overlap.
const overlap = (a: ReadonlyArray<Interval>, b: ReadonlyArray<Interval>) =>
  Effect.sync((): ReadonlyArray<Interval> =>
    a.flatMap((x) =>
      b.flatMap((y) => {
        const from = DateTime.max(x.from, y.from)
        const to = DateTime.min(x.to, y.to)
        return DateTime.Order(from, to) < 0 ? [{ from, to }] : []
      })
    )
  )

export const makeFeedHealth = Effect.fnUntraced(function* (options: {
  // The day's stretches that expect trades.
  readonly stretches: ReadonlyArray<Interval>
  // Where the record starts: the feeds count as down from here until the
  // relay first delivers.
  readonly since: DateTime.Utc
  // What an object stored before it restarted at `at`. A feed up when the
  // record was stored counts as down again from the restart.
  readonly restored?: { readonly record: DownRecord; readonly at: DateTime.Utc }
}) {
  const { stretches } = options
  let relayOnline = false
  const tracks: Record<Feed, Track> = {
    Stockbit: yield* newTrack,
    Ajaib: yield* newTrack,
  }
  for (const feed of FEEDS) {
    const { restored } = options
    if (restored === undefined) {
      tracks[feed].downs.push({ from: options.since, to: undefined })
      continue
    }
    const downs = tracks[feed].downs
    for (const down of restored.record[feed])
      downs.push({
        from: DateTime.makeUnsafe(down.from),
        to: down.to === undefined ? undefined : DateTime.makeUnsafe(down.to),
      })
    if (downs.length === 0 || downs.at(-1)?.to !== undefined)
      downs.push({ from: restored.at, to: undefined })
  }

  const freshnessAt = Effect.fnUntraced(function* (
    track: Track,
    now: DateTime.Utc
  ): Effect.fn.Return<Freshness> {
    if (!relayOnline || track.lastSign === undefined || track.open.size === 0)
      return "unavailable"
    const silence = yield* expectedBetween(stretches, track.lastSign, now)
    if (silence >= UNAVAILABLE_AFTER) return "unavailable"
    if (silence >= STALE_AFTER) return "stale"
    return "live"
  })

  // Opens a down stretch for a feed that stopped being live by `now`, from
  // the instant it did: the moment its silence reached 15 s.
  const observe = Effect.fnUntraced(function* (now: DateTime.Utc) {
    for (const feed of FEEDS) {
      const track = tracks[feed]
      if (track.downs.at(-1)?.to === undefined && track.downs.length > 0)
        continue
      if ((yield* freshnessAt(track, now)) === "live") continue
      const from =
        track.lastSign === undefined
          ? now
          : ((yield* afterExpected(stretches, track.lastSign, STALE_AFTER)) ??
            now)
      track.downs.push({ from: DateTime.min(from, now), to: undefined })
    }
  })

  const goDown = (track: Track, at: DateTime.Utc) =>
    Effect.sync(() => {
      if (track.downs.at(-1)?.to !== undefined || track.downs.length === 0)
        track.downs.push({ from: at, to: undefined })
    })

  // Running trades timed at their first relayed arrival on their feed. Each
  // feed is judged at its newest arrival too, so a median that crosses a
  // threshold between two conditions isn't missed.
  const recordLags = Effect.fnUntraced(function* (
    trades: ReadonlyArray<TimedTrade>
  ) {
    const newest = new Map<Feed, number>()
    for (const { feed, arrived, lag } of trades) {
      tracks[feed].lags.push({ arrived, lag })
      newest.set(feed, arrived)
    }
    for (const [feed, arrived] of newest) yield* judgeLag(tracks[feed], arrived)
  })

  // A frame or a ping reply on one of a feed's connections.
  const sign = Effect.fnUntraced(function* (
    feed: Feed,
    connection: Connection,
    at: DateTime.Utc
  ) {
    yield* observe(at)
    const track = tracks[feed]
    // A feed back from stale or unavailable starts over undelayed, its lag
    // window emptied: a reconnect inside it would re-read the old lags.
    if ((yield* freshnessAt(track, at)) !== "live") {
      track.delayedBy = undefined
      track.lags.length = 0
    }
    track.lastSign = at
    track.open.add(connection)
    const last = track.downs.at(-1)
    if (relayOnline && last !== undefined && last.to === undefined) last.to = at
  })

  // The relay reported one of a feed's connections closed: with none left,
  // the feed is unavailable at once.
  const closed = Effect.fnUntraced(function* (
    feed: Feed,
    connection: Connection,
    at: DateTime.Utc
  ) {
    yield* observe(at)
    const track = tracks[feed]
    track.open.delete(connection)
    if (track.open.size === 0) yield* goDown(track, at)
  })

  const online = Effect.sync(() => {
    relayOnline = true
  })

  // No ingest socket left: both feeds unavailable, and each starts over from
  // its first frame.
  const offline = Effect.fnUntraced(function* (at: DateTime.Utc) {
    yield* observe(at)
    relayOnline = false
    for (const feed of FEEDS) {
      const track = tracks[feed]
      track.lastSign = undefined
      track.open.clear()
      yield* goDown(track, at)
    }
  })

  // Each feed's down stretches, the one still running ending at `now`.
  const downsUntil = (feed: Feed, now: DateTime.Utc) =>
    Effect.sync(() =>
      tracks[feed].downs.map((down) => ({
        from: down.from,
        to: down.to ?? now,
      }))
    )

  // Where both feeds were down at once inside a stretch that expects trades,
  // up to `now`. The one still running has no end.
  const gapsAt = Effect.fnUntraced(function* (
    now: DateTime.Utc
  ): Effect.fn.Return<ReadonlyArray<RelayGap>> {
    const pieces: Array<Interval> = []
    for (const piece of yield* overlap(
      yield* overlap(
        yield* downsUntil("Stockbit", now),
        yield* downsUntil("Ajaib", now)
      ),
      stretches
    )) {
      const last = pieces.at(-1)
      if (last !== undefined && DateTime.Order(last.to, piece.from) >= 0)
        pieces[pieces.length - 1] = { from: last.from, to: piece.to }
      else pieces.push(piece)
    }
    return pieces.map((piece) =>
      DateTime.Order(piece.to, now) >= 0
        ? { from: piece.from }
        : { from: piece.from, to: piece.to }
    )
  })

  // A feed's freshness at `now`, with its lag while it is delayed. Silence
  // outranks the lag.
  const feedAt = Effect.fnUntraced(function* (track: Track, now: DateTime.Utc) {
    const silence = yield* freshnessAt(track, now)
    yield* judgeLag(track, millis(now))
    const lag = track.delayedBy
    return silence === "live" && lag !== undefined
      ? { freshness: "delayed" as const, lag }
      : { freshness: silence, lag: undefined }
  })

  // The feeds' part of the market conditions viewers are told at `now`.
  const conditionsAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
    yield* observe(now)
    const states = yield* Effect.all(
      Records.map(tracks, (track) => feedAt(track, now))
    )
    const lags: Partial<Record<Feed, number>> = {}
    for (const feed of FEEDS) {
      const { lag } = states[feed]
      if (lag !== undefined) lags[feed] = lag
    }
    return {
      relayOnline,
      feeds: Records.map(states, (state) => state.freshness),
      ...(Object.keys(lags).length === 0 ? {} : { lags }),
      gaps: yield* gapsAt(now),
    }
  })

  // Each feed's down stretches so far, for storage.
  const downsOf = (feed: Feed) =>
    Effect.sync(() =>
      tracks[feed].downs.map((down) =>
        down.to === undefined
          ? { from: millis(down.from) }
          : { from: millis(down.from), to: millis(down.to) }
      )
    )
  const record = Effect.gen(function* () {
    const downs: DownRecord = {
      Stockbit: yield* downsOf("Stockbit"),
      Ajaib: yield* downsOf("Ajaib"),
    }
    return downs
  })

  return { recordLags, sign, closed, online, offline, conditionsAt, record }
})
