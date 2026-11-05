import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"
import type { MinuteCandle, TapeCoverage, TradeSource } from "@/domain/trade"
import { chartSlots, fitKey, volumeBars } from "@/features/radar/chart-slots"

/** 2026-10-29 is a Thursday: sessions 09:00–12:00 and 13:30–15:50 WIB. */
const DAY = "2026-10-29"
const wib = (hhmmss: string) =>
  IsoDateTime.make(new Date(`${DAY}T${hhmmss}+07:00`).toISOString())
const at = (hhmmss: string) => Date.parse(wib(hhmmss))

const candle = (hhmm: string, price = 100): MinuteCandle => ({
  at: wib(`${hhmm}:00`),
  open: price,
  high: price,
  low: price,
  close: price,
  lots: 1,
})
const change = (hhmmss: string, source: TradeSource): TapeCoverage => ({
  at: wib(hhmmss),
  source,
})
const COVERED = [change("08:00:00", "extension")]
const MINUTE = 60_000

const slots = (
  over: Partial<Parameters<typeof chartSlots>[0]> = {}
): ReturnType<typeof chartSlots> =>
  chartSlots({
    day: DAY,
    minutes: [],
    coverage: COVERED,
    periodMs: MINUTE,
    nowMs: at("09:02:30"),
    ...over,
  })

describe("chartSlots", () => {
  test("a quiet minute keeps an empty slot, up to the current minute", () => {
    const { slots: shown } = slots({
      minutes: [candle("09:00"), candle("09:02", 110)],
    })
    expect(shown).toEqual([
      { at: wib("09:00:00"), candle: candle("09:00"), gap: false },
      { at: wib("09:01:00"), candle: null, gap: false },
      { at: wib("09:02:00"), candle: candle("09:02", 110), gap: false },
    ])
  })

  test("the lunch break has no slot, and the second session is marked", () => {
    const { slots: shown, secondSession } = slots({
      nowMs: at("13:31:10"),
    })
    expect(shown.map((s) => s.at)).not.toContain(wib("12:00:00"))
    expect(shown.map((s) => s.at)).not.toContain(wib("13:29:00"))
    expect(shown).toHaveLength(180 + 2)
    expect(shown.at(179)?.at).toBe(wib("11:59:00"))
    expect(shown.at(180)?.at).toBe(wib("13:30:00"))
    expect(secondSession).toBe(wib("13:30:00"))
  })

  test("before the second session, nothing is marked", () => {
    expect(slots().secondSession).toBeNull()
  })

  test("a minute without a source is a gap; a quiet one is not", () => {
    const shown = slots({
      coverage: [
        change("08:00:00", "extension"),
        change("09:01:20", "none"),
        change("09:02:10", "upstream"),
      ],
      nowMs: at("09:04:00"),
    }).slots
    expect(shown.map((s) => [s.at, s.gap])).toEqual([
      [wib("09:00:00"), false],
      [wib("09:01:00"), true],
      [wib("09:02:00"), true],
      [wib("09:03:00"), false],
      [wib("09:04:00"), false],
    ])
  })

  test("a source lost only in the lunch break shades no hour", () => {
    const shown = slots({
      coverage: [
        change("08:00:00", "extension"),
        change("12:00:00", "none"),
        change("13:20:00", "extension"),
      ],
      periodMs: 60 * MINUTE,
      nowMs: at("14:30:00"),
    }).slots
    expect(shown.map((s) => [s.at, s.gap])).toEqual([
      [wib("09:00:00"), false],
      [wib("10:00:00"), false],
      [wib("11:00:00"), false],
      [wib("13:00:00"), false],
      [wib("14:00:00"), false],
    ])
  })

  test("a source lost in the closing auction shades the period it falls in", () => {
    const shown = slots({
      minutes: [candle("15:45"), candle("15:59")],
      coverage: [
        change("08:00:00", "extension"),
        change("15:52:00", "none"),
        change("15:58:00", "extension"),
      ],
      periodMs: 15 * MINUTE,
      nowMs: at("16:30:00"),
    }).slots
    expect(shown.find((s) => s.at === wib("15:45:00"))?.gap).toBe(true)
    expect(shown.find((s) => s.at === wib("15:30:00"))?.gap).toBe(false)
  })

  test("a source still down runs the gap to now", () => {
    const shown = slots({
      coverage: [change("08:00:00", "extension"), change("09:01:00", "none")],
    }).slots
    expect(shown.map((s) => s.gap)).toEqual([false, true, true])
  })

  test("before the first recorded source, no source was known", () => {
    expect(
      slots({ coverage: [change("09:02:00", "extension")] }).slots.map(
        (s) => s.gap
      )
    ).toEqual([true, true, false])
  })

  test("a longer period has a slot per period, and a trade outside the sessions keeps its candle", () => {
    const { slots: shown, secondSession } = slots({
      minutes: [candle("08:59"), candle("09:07")],
      periodMs: 5 * MINUTE,
      nowMs: at("15:00:00"),
    })
    expect(
      shown.slice(0, 3).map((s) => [s.at, s.candle?.lots ?? null])
    ).toEqual([
      [wib("08:55:00"), 1],
      [wib("09:00:00"), null],
      [wib("09:05:00"), 1],
    ])
    expect(secondSession).toBe(wib("13:30:00"))
  })

  test("a past session shows whole, and a day not known shows only its candles", () => {
    expect(slots({ nowMs: at("23:00:00") }).slots).toHaveLength(180 + 140)
    expect(
      slots({ day: null, minutes: [candle("10:00")] }).slots.map((s) => s.at)
    ).toEqual([wib("10:00:00")])
  })
})

describe("volumeBars", () => {
  test("every slot has a bar, a quiet one with no lots, so the scale ends on the latest slot", () => {
    const shown = slots({ minutes: [candle("09:00")] }).slots
    expect(volumeBars(shown)).toEqual([
      { at: wib("09:00:00"), lots: 1, tone: "up" },
      { at: wib("09:01:00"), lots: 0, tone: "quiet" },
      { at: wib("09:02:00"), lots: 0, tone: "quiet" },
    ])
  })
})

describe("fitKey", () => {
  const MINUTE_PERIOD = { label: "1m" }
  test("a page opened before the first trade fits again once a candle arrives, and only then", () => {
    const quiet = slots({ nowMs: at("09:05:00") })
    const first = slots({ minutes: [candle("09:05")], nowMs: at("09:05:30") })
    const later = slots({
      minutes: [candle("09:05"), candle("09:06")],
      nowMs: at("09:06:30"),
    })
    expect(fitKey(MINUTE_PERIOD, first)).not.toBe(fitKey(MINUTE_PERIOD, quiet))
    expect(fitKey(MINUTE_PERIOD, later)).toBe(fitKey(MINUTE_PERIOD, first))
    expect(fitKey({ label: "5m" }, later)).not.toBe(
      fitKey(MINUTE_PERIOD, later)
    )
  })
})
