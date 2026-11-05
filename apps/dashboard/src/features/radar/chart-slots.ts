// Where the live chart's candles sit on its time scale. The library spaces candles by index,
// so a quiet period needs an empty slot, and the lunch break needs none.
// No `effect` here, and the domain only as types.
import type { IsoDateTime } from "@/domain/time"
import type { MinuteCandle, TapeCoverage } from "@/domain/trade"
import { hoursOn, phaseAt } from "@/relay/calendar"
import type { Hours, Phase } from "@/relay/calendar"
import { MINUTE_MS, candlesOfPeriod, periodOf } from "@/relay/candles"
import { WIB_MS } from "@/relay/trading-day"

export type ChartSlot = {
  /** The period's start. */
  readonly at: IsoDateTime
  /** Null in a period with no regular-board trades. */
  readonly candle: MinuteCandle | null
  /** The relay had no source for some of the period, so trades in it went unseen. */
  readonly gap: boolean
}

export type ChartSlots = {
  /** Oldest first. */
  readonly slots: ReadonlyArray<ChartSlot>
  /** The second session's first slot, once one follows the first session's. */
  readonly secondSession: IsoDateTime | null
}

/** Phases with no trades to miss. */
const UNTRADED: ReadonlySet<Phase> = new Set(["break", "closed"])

type Span = { readonly from: number; readonly to: number }

/** `HH:MM` WIB on a `YYYY-MM-DD`. */
const startOf = (day: string, hhmm: string) =>
  Date.parse(`${day}T${hhmm}:00Z`) - WIB_MS

const sessionHours = (day: string): ReadonlyArray<Hours> =>
  hoursOn(day).filter((h) => h.phase === "session-1" || h.phase === "session-2")

/** The trading minutes of a day's sessions that have begun by `nowMs`. */
const tradingMinutes = (day: string, nowMs: number) =>
  sessionHours(day).flatMap((h) => {
    const minutes: Array<number> = []
    const to = Math.min(startOf(day, h.to), nowMs + 1)
    for (let ms = startOf(day, h.from); ms < to; ms += MINUTE_MS)
      minutes.push(ms)
    return minutes
  })

/** When the relay had no source: before its first recorded change too, and up to now. */
const gapSpans = (coverage: ReadonlyArray<TapeCoverage>): Array<Span> => {
  const changes = [...coverage].sort((a, b) => a.at.localeCompare(b.at))
  const spans: Array<Span> = []
  let from: number | null = -Infinity
  for (const { at, source } of changes) {
    const ms = Date.parse(at)
    if (source === "none") from ??= ms
    else if (from !== null) {
      spans.push({ from, to: ms })
      from = null
    }
  }
  if (from !== null) spans.push({ from, to: Infinity })
  return spans
}

/** One slot per period: every trading period begun by `nowMs`, and any other with a candle. */
export const chartSlots = ({
  day,
  minutes,
  coverage,
  periodMs,
  nowMs,
}: {
  /** The tape's trading day; null shows only the candles. */
  readonly day: string | null
  readonly minutes: ReadonlyArray<MinuteCandle>
  readonly coverage: ReadonlyArray<TapeCoverage>
  readonly periodMs: number
  readonly nowMs: number
}): ChartSlots => {
  const candles = new Map<IsoDateTime, MinuteCandle>(
    candlesOfPeriod(minutes, periodMs).map((c) => [c.at, c])
  )
  const periods = new Set<IsoDateTime>(candles.keys())
  if (day !== null)
    for (const ms of tradingMinutes(day, nowMs))
      periods.add(periodOf(new Date(ms).toISOString(), periodMs))
  const spans = gapSpans(coverage)
  const unseen = (from: number, to: number) =>
    spans.some((s) => s.from < to && from < s.to)
  /** A source lost in the break or after hours misses no trade, so those minutes do not count. */
  const gapIn = (from: number) => {
    let counted = false
    for (let ms = from; ms < from + periodMs; ms += MINUTE_MS) {
      if (UNTRADED.has(phaseAt(ms))) continue
      counted = true
      if (unseen(ms, ms + MINUTE_MS)) return true
    }
    return !counted && unseen(from, from + periodMs)
  }
  const slots = [...periods].sort().map((at): ChartSlot => ({
    at,
    candle: candles.get(at) ?? null,
    gap: gapIn(Date.parse(at)),
  }))
  return { slots, secondSession: secondSession(day, slots, periodMs) }
}

const secondSession = (
  day: string | null,
  slots: ReadonlyArray<ChartSlot>,
  periodMs: number
): IsoDateTime | null => {
  if (day === null) return null
  const [first, second] = sessionHours(day)
  if (!first || !second) return null
  const iso = (ms: number) => periodOf(new Date(ms).toISOString(), periodMs)
  const lastOfFirst = iso(startOf(day, first.to) - MINUTE_MS)
  const firstOfSecond = iso(startOf(day, second.from))
  if (firstOfSecond <= lastOfFirst) return null
  const before = slots.some((s) => s.at < firstOfSecond)
  const after = slots.find((s) => s.at >= firstOfSecond)
  return before && after ? after.at : null
}

export type VolumeBar = {
  readonly at: IsoDateTime
  readonly lots: number
  /** Quiet in a slot with no candle, whose bar the chart does not draw. */
  readonly tone: "up" | "down" | "quiet"
}

/**
 * One volume bar per slot. The library ends its time scale on the last point that is not
 * whitespace, so a quiet slot's bar keeps the latest slot in reach of the operator's zoom and of
 * the scale's following.
 */
export const volumeBars = (
  slots: ReadonlyArray<ChartSlot>
): ReadonlyArray<VolumeBar> =>
  slots.map(({ at, candle }) => ({
    at,
    lots: candle?.lots ?? 0,
    tone:
      candle === null ? "quiet" : candle.close >= candle.open ? "up" : "down",
  }))

/**
 * What the chart fits to: a new period, or the first candle. A chart with no candles is hidden,
 * so the fit it made then would keep a page opened before the first trade unlike a reload.
 */
export const fitKey = (
  period: { readonly label: string },
  { slots }: ChartSlots
) => `${period.label}:${slots.some((s) => s.candle !== null)}`
