// Each feed's freshness and the day's relay gaps (spec apinrdw/kumora#138,
// "Feed freshness"). Everything is decided from instants the caller reads
// through Effect's Clock, so the tests drive it with TestClock.
import {
  type Connection,
  type Feed,
  type Freshness,
  type Interval,
  type RelayGap,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: a feed is stale after 15 s of silence and unavailable after 60 s,
// counted only inside stretches that expect trades (the sessions,
// post-trading and the two match minutes), so the break and the auctions
// before their match never go stale. A Stockbit frame, an Ajaib trade-stream
// frame or a ping reply is a sign of life; Ajaib's on-demand frames answer a
// subscription and say nothing about its tape (market-conditions.ts decides
// which frames count). See apinrdw/kumora#133.
const STALE_AFTER = 15_000
const UNAVAILABLE_AFTER = 60_000

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
}

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
    Stockbit: { lastSign: undefined, open: new Set(), downs: [] },
    Ajaib: { lastSign: undefined, open: new Set(), downs: [] },
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

  // A frame or a ping reply on one of a feed's connections.
  const sign = Effect.fnUntraced(function* (
    feed: Feed,
    connection: Connection,
    at: DateTime.Utc
  ) {
    yield* observe(at)
    const track = tracks[feed]
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

  // The feeds' part of the market conditions viewers are told at `now`.
  const conditionsAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
    yield* observe(now)
    return {
      relayOnline,
      feeds: {
        Stockbit: yield* freshnessAt(tracks.Stockbit, now),
        Ajaib: yield* freshnessAt(tracks.Ajaib, now),
      },
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

  return { sign, closed, online, offline, conditionsAt, record }
})
