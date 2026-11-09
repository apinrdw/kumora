// The replay cursor over a recorded day (spec apinrdw/kumora#138, "Closed
// market and recorded days"): where Play moves it, and what the tape and
// relay gaps read at it. Instants are epoch milliseconds.
import type {
  MarketPhase,
  PhaseInterval,
  RelayGap,
  WibDate,
} from "@workspace/relay"
import { DateTime } from "effect"

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
// minute, and its market phases: the session bands and the break Play skips.
export type ReplayDay = {
  readonly date: WibDate
  readonly start: number
  readonly close: number
  readonly bands: ReadonlyArray<Band>
}

export function replayDay(
  day: WibDate,
  phases: ReadonlyArray<PhaseInterval>
): ReplayDay {
  return {
    date: day,
    start: DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T08:45:00+07:00`)),
    close: DateTime.toEpochMillis(closeOf(day)),
    bands: phases.map(({ phase, from, to }) => ({
      phase,
      from: DateTime.toEpochMillis(from),
      to: DateTime.toEpochMillis(to),
    })),
  }
}

/**
 * The cursor after `elapsed` real milliseconds of Play at `speed`: a cursor
 * that lands in the lunch break jumps to session 2's open, and one that
 * reaches the close stops there, `ended`.
 */
export function advance(
  day: ReplayDay,
  at: number,
  elapsed: number,
  speed: Speed
): { readonly at: number; readonly ended: boolean } {
  let next = at + elapsed * speed
  for (const band of day.bands)
    if (band.phase === "break" && band.from <= next && next < band.to)
      next = band.to
  return next >= day.close
    ? { at: day.close, ended: true }
    : { at: next, ended: false }
}

// Where Play starts: from the cursor, or over from 08:45 at the close.
export const playFrom = (day: ReplayDay, at: number) =>
  at >= day.close ? day.start : at

// A candle click's cursor: the end of that candle's minute.
export const minuteEnd = (minute: number) => minute + 59_999

// Decision: the tape is asked at the end of the cursor's second, a whole
// second's worth of cursors sharing one URL (so a sealed day's answer
// caches) and every trade of that second included.
export const tapeInstant = (at: number) => Math.floor(at / 1_000) * 1_000 + 999

// The relay gap the cursor is in: from its start up to, not including, its
// end; one with no end runs to the close.
export const gapAt = (gaps: ReadonlyArray<RelayGap>, at: number) =>
  gaps.find(
    (gap) =>
      DateTime.toEpochMillis(gap.from) <= at &&
      (gap.to === undefined || at < DateTime.toEpochMillis(gap.to))
  )

// The scrubber steps whole seconds from 08:45, so its last step is the close
// minute's last whole second: dragged there, the cursor is at the close.
export const scrubbedTo = (day: ReplayDay, value: number) =>
  value > day.close - 1_000 ? day.close : value

const MINUTE = 60_000

/**
 * The minutes the relay gaps touch, as minute starts, in ascending runs: the
 * chart shades them as not recorded. Gaps that touch the same minute, or
 * overlap, make one run, so no minute appears twice. A gap with no end runs
 * to `end`.
 */
export function gapMinutes(
  gaps: ReadonlyArray<RelayGap>,
  end: number
): ReadonlyArray<ReadonlyArray<number>> {
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
}
