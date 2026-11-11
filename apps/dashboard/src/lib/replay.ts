// The replay cursor over a recorded day (spec apinrdw/kumora#138, "Closed
// market and recorded days"): where Play moves it, and what the tape and
// relay gaps read at it. Instants are epoch milliseconds.
import {
  streamingEndOf,
  type MarketPhase,
  type PhaseInterval,
  type RelayGap,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { closeOf } from "./recorded-day"

export const SPEEDS = [1, 10, 60, 300] as const
export type Speed = (typeof SPEEDS)[number]

// Decision: during Play the tape is asked at most 4 times a second (spec,
// "Recorded day loads").
export const TAPE_INTERVAL_MS = 250

export type Band = {
  readonly phase: MarketPhase
  readonly from: number
  readonly to: number
}

// A recorded day's span for the scrubber, 08:45 to the end of the close
// minute; where its record ends; and its market phases: the session bands
// and the break Play skips.
export type ReplayDay = {
  readonly date: WibDate
  readonly start: number
  readonly close: number
  // Decision: the scrubber and Play end at the close, 16:15, as the spec's
  // transport bar says, but the relay records until it stops streaming at
  // 16:35, when the negotiated board has closed too. The tape at the close
  // reads at the record's end, so every stored trade of the day shows there;
  // the chart and watchlist read regular-board candles, which end by 16:15.
  readonly end: number
  readonly bands: ReadonlyArray<Band>
}

export const replayDay = Effect.fnUntraced(function* (
  day: WibDate,
  phases: ReadonlyArray<PhaseInterval>
): Effect.fn.Return<ReplayDay> {
  return {
    date: day,
    start: DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T08:45:00+07:00`)),
    close: DateTime.toEpochMillis(yield* closeOf(day)),
    end: DateTime.toEpochMillis(yield* streamingEndOf(day)),
    bands: phases.map(({ phase, from, to }) => ({
      phase,
      from: DateTime.toEpochMillis(from),
      to: DateTime.toEpochMillis(to),
    })),
  }
})

/**
 * The cursor after `elapsed` real milliseconds of Play at `speed`: a cursor
 * that lands in the lunch break jumps to session 2's open, and one that
 * reaches the close stops there, `ended`.
 */
export const advance = (
  day: ReplayDay,
  at: number,
  elapsed: number,
  speed: Speed
): Effect.Effect<{ readonly at: number; readonly ended: boolean }> =>
  Effect.sync(() => {
    let next = at + elapsed * speed
    for (const band of day.bands)
      if (band.phase === "break" && band.from <= next && next < band.to)
        next = band.to
    return next >= day.close
      ? { at: day.close, ended: true }
      : { at: next, ended: false }
  })

// Where Play starts: from the cursor, or over from 08:45 at the close.
export const playFrom = (day: ReplayDay, at: number) =>
  Effect.sync(() => (at >= day.close ? day.start : at))

// A candle click's cursor: the end of that candle's minute.
export const minuteEnd = (minute: number) => Effect.sync(() => minute + 59_999)

// Decision: the tape is asked at the end of the cursor's second, a whole
// second's worth of cursors sharing one URL (so a sealed day's answer
// caches) and every trade of that second included; at the close it is asked
// at the day's end, for the trades after 16:15.
export const tapeInstant = (day: ReplayDay, at: number) =>
  Effect.sync(() =>
    at >= day.close ? day.end : Math.floor(at / 1_000) * 1_000 + 999
  )

// The relay gap the cursor is in: from its start up to, not including, its
// end; one with no end runs to the close.
export const gapAt = (gaps: ReadonlyArray<RelayGap>, at: number) =>
  Effect.sync(() =>
    gaps.find(
      (gap) =>
        DateTime.toEpochMillis(gap.from) <= at &&
        (gap.to === undefined || at < DateTime.toEpochMillis(gap.to))
    )
  )

// The scrubber steps whole seconds from 08:45, so its last step is the close
// minute's last whole second: dragged there, the cursor is at the close.
export const scrubbedTo = (day: ReplayDay, value: number) =>
  Effect.sync(() => (value > day.close - 1_000 ? day.close : value))

const MINUTE = 60_000

/**
 * The minutes the relay gaps touch, as minute starts, in ascending runs: the
 * chart shades them as not recorded. Gaps that touch the same minute, or
 * overlap, make one run, so no minute appears twice. A gap with no end runs
 * to `end`.
 */
export const gapMinutes = Effect.fnUntraced(function* (
  gaps: ReadonlyArray<RelayGap>,
  end: number
): Effect.fn.Return<ReadonlyArray<ReadonlyArray<number>>> {
  const runs: Array<Array<number>> = []
  const spans = gaps
    .map((gap) => ({
      from: Math.floor(DateTime.toEpochMillis(gap.from) / MINUTE) * MINUTE,
      to: gap.to === undefined ? end + 1 : DateTime.toEpochMillis(gap.to),
    }))
    .sort((a, b) => a.from - b.from)
  for (const { from, to } of spans) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    const minutes =
      run !== undefined && last !== undefined && from <= last ? run : []
    for (
      let minute = Math.max(from, (last ?? from - MINUTE) + MINUTE);
      minute < to;
      minute += MINUTE
    )
      minutes.push(minute)
    if (minutes !== run && minutes.length > 0) runs.push(minutes)
  }
  return runs
})
