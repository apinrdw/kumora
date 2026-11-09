import { WibDate, marketPhases, type RelayGap } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, test } from "vitest"

import {
  advance,
  gapAt,
  gapMinutes,
  minuteEnd,
  playFrom,
  replayDay,
  scrubbedTo,
  tapeInstant,
} from "@/lib/replay"

// 2026-11-09 is a Monday: session 1 ends 12:00:00, session 2 opens 13:30.
const DAY = WibDate.make("2026-11-09")
const at = (wib: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`${DAY}T${wib}+07:00`))
const day = replayDay(DAY, Effect.runSync(marketPhases(DAY)))

describe("the replay cursor", () => {
  test("runs from 08:45 to the end of the close minute", () => {
    expect(day.start).toBe(at("08:45:00"))
    expect(day.close).toBe(at("16:15:59.999"))
  })

  test("moves by the real time elapsed times the speed", () => {
    expect(advance(day, at("10:00:00"), 1_000, 1)).toEqual({
      at: at("10:00:01"),
      ended: false,
    })
    expect(advance(day, at("10:00:00"), 500, 300)).toEqual({
      at: at("10:02:30"),
      ended: false,
    })
  })

  test("skips the lunch break to session 2", () => {
    expect(advance(day, at("11:59:50"), 1_000, 60).at).toBe(at("13:30:00"))
    // A cursor set inside the break moves on from session 2's open.
    expect(advance(day, at("12:30:00"), 1_000, 1).at).toBe(at("13:30:00"))
  })

  test("stops at the close", () => {
    expect(advance(day, at("16:15:00"), 1_000, 300)).toEqual({
      at: day.close,
      ended: true,
    })
  })

  test("Play at the close starts over from 08:45", () => {
    expect(playFrom(day, day.close)).toBe(day.start)
    expect(playFrom(day, at("10:00:00"))).toBe(at("10:00:00"))
  })

  test("a candle click lands at the end of that minute", () => {
    expect(minuteEnd(at("10:15:00"))).toBe(at("10:15:59.999"))
  })

  test("asks the tape for the end of the cursor's second", () => {
    expect(tapeInstant(at("10:15:32.400"))).toBe(at("10:15:32.999"))
    expect(tapeInstant(at("10:15:32.999"))).toBe(at("10:15:32.999"))
  })
})

describe("a relay gap at the cursor", () => {
  const gap = (from: string, to?: string): RelayGap => ({
    from: DateTime.makeUnsafe(at(from)),
    ...(to === undefined ? {} : { to: DateTime.makeUnsafe(at(to)) }),
  })
  const gaps = [gap("10:00:00", "10:05:00"), gap("15:00:00")]

  test("covers its start but not its end", () => {
    expect(gapAt(gaps, at("09:59:59.999"))).toBeUndefined()
    expect(gapAt(gaps, at("10:00:00"))).toBe(gaps[0])
    expect(gapAt(gaps, at("10:04:59"))).toBe(gaps[0])
    expect(gapAt(gaps, at("10:05:00"))).toBeUndefined()
  })

  test("with no end runs to the close", () => {
    expect(gapAt(gaps, day.close)).toBe(gaps[1])
  })
})

describe("the scrubber", () => {
  test("dragged to its end lands on the close, not the last whole second", () => {
    expect(scrubbedTo(day, at("16:15:59"))).toBe(day.close)
    expect(scrubbedTo(day, at("16:15:58"))).toBe(at("16:15:58"))
    expect(scrubbedTo(day, at("10:00:00"))).toBe(at("10:00:00"))
  })
})

describe("a relay gap on the chart", () => {
  const gap = (from: string, to?: string): RelayGap => ({
    from: DateTime.makeUnsafe(`${DAY}T${from}+07:00`),
    ...(to === undefined
      ? {}
      : { to: DateTime.makeUnsafe(`${DAY}T${to}+07:00`) }),
  })

  test("covers each minute it touches, one run per gap", () => {
    expect(
      gapMinutes(
        [gap("10:01:30", "10:03:00"), gap("11:00:00", "11:01:00")],
        at("16:15:59.999")
      )
    ).toEqual([[at("10:01:00"), at("10:02:00")], [at("11:00:00")]])
  })

  test("gaps that touch the same minute, or overlap, make one run", () => {
    expect(
      gapMinutes(
        [
          gap("10:05:40", "10:07:00"),
          gap("10:01:30", "10:02:10"),
          gap("10:02:40", "10:03:00"),
          gap("10:06:00"),
        ],
        at("10:07:30")
      )
    ).toEqual([
      [at("10:01:00"), at("10:02:00")],
      [at("10:05:00"), at("10:06:00"), at("10:07:00")],
    ])
  })

  test("an open gap runs to the end given", () => {
    expect(gapMinutes([gap("15:58:10")], at("16:00:30"))).toEqual([
      [at("15:58:00"), at("15:59:00"), at("16:00:00")],
    ])
  })
})
