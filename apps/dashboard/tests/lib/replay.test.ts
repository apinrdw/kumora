import { WibDate, marketPhases, type RelayGap } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  advance,
  cursorLogical,
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
const day = Effect.runSync(
  Effect.flatMap(marketPhases(DAY), (phases) => replayDay(DAY, phases))
)

describe("the replay cursor", () => {
  it.effect("runs from 08:45 to the end of the close minute", () =>
    Effect.gen(function* () {
      expect(day.start).toBe(at("08:45:00"))
      expect(day.close).toBe(at("16:15:59.999"))
    })
  )

  it.effect("records until the relay stops streaming, 16:35", () =>
    Effect.gen(function* () {
      expect(day.end).toBe(at("16:34:59.999"))
    })
  )

  it.effect("moves by the real time elapsed times the speed", () =>
    Effect.gen(function* () {
      expect(yield* advance(day, at("10:00:00"), 1_000, 1)).toEqual({
        at: at("10:00:01"),
        ended: false,
      })
      expect(yield* advance(day, at("10:00:00"), 500, 300)).toEqual({
        at: at("10:02:30"),
        ended: false,
      })
    })
  )

  it.effect("skips the lunch break to session 2", () =>
    Effect.gen(function* () {
      expect((yield* advance(day, at("11:59:50"), 1_000, 60)).at).toBe(
        at("13:30:00")
      )
      // A cursor set inside the break moves on from session 2's open.
      expect((yield* advance(day, at("12:30:00"), 1_000, 1)).at).toBe(
        at("13:30:00")
      )
    })
  )

  it.effect("stops at the close", () =>
    Effect.gen(function* () {
      expect(yield* advance(day, at("16:15:00"), 1_000, 300)).toEqual({
        at: day.close,
        ended: true,
      })
    })
  )

  it.effect("Play at the close starts over from 08:45", () =>
    Effect.gen(function* () {
      expect(yield* playFrom(day, day.close)).toBe(day.start)
      expect(yield* playFrom(day, at("10:00:00"))).toBe(at("10:00:00"))
    })
  )

  it.effect("a candle click lands at the end of that minute", () =>
    Effect.gen(function* () {
      expect(yield* minuteEnd(at("10:15:00"))).toBe(at("10:15:59.999"))
    })
  )

  it.effect("asks the tape for the end of the cursor's second", () =>
    Effect.gen(function* () {
      expect(yield* tapeInstant(day, at("10:15:32.400"))).toBe(
        at("10:15:32.999")
      )
      expect(yield* tapeInstant(day, at("10:15:32.999"))).toBe(
        at("10:15:32.999")
      )
    })
  )

  it.effect(
    "asks the tape at the day's end when the cursor is at the close",
    () =>
      Effect.gen(function* () {
        expect(yield* tapeInstant(day, day.close)).toBe(day.end)
        expect(yield* tapeInstant(day, at("16:15:59.000"))).toBe(
          at("16:15:59.999")
        )
      })
  )
})

describe("a relay gap at the cursor", () => {
  const gap = (from: string, to?: string): RelayGap => ({
    from: DateTime.makeUnsafe(at(from)),
    ...(to === undefined ? {} : { to: DateTime.makeUnsafe(at(to)) }),
  })
  const gaps = [gap("10:00:00", "10:05:00"), gap("15:00:00")]

  it.effect("covers its start but not its end", () =>
    Effect.gen(function* () {
      expect(yield* gapAt(gaps, at("09:59:59.999"))).toBeUndefined()
      expect(yield* gapAt(gaps, at("10:00:00"))).toBe(gaps[0])
      expect(yield* gapAt(gaps, at("10:04:59"))).toBe(gaps[0])
      expect(yield* gapAt(gaps, at("10:05:00"))).toBeUndefined()
    })
  )

  it.effect("with no end runs to the close", () =>
    Effect.gen(function* () {
      expect(yield* gapAt(gaps, day.close)).toBe(gaps[1])
    })
  )
})

describe("the scrubber", () => {
  it.effect(
    "dragged to its end lands on the close, not the last whole second",
    () =>
      Effect.gen(function* () {
        expect(yield* scrubbedTo(day, at("16:15:59"))).toBe(day.close)
        expect(yield* scrubbedTo(day, at("16:15:58"))).toBe(at("16:15:58"))
        expect(yield* scrubbedTo(day, at("10:00:00"))).toBe(at("10:00:00"))
      })
  )
})

describe("a relay gap on the chart", () => {
  const gap = (from: string, to?: string): RelayGap => ({
    from: DateTime.makeUnsafe(`${DAY}T${from}+07:00`),
    ...(to === undefined
      ? {}
      : { to: DateTime.makeUnsafe(`${DAY}T${to}+07:00`) }),
  })

  it.effect("covers each minute it touches, one run per gap", () =>
    Effect.gen(function* () {
      expect(
        yield* gapMinutes(
          [gap("10:01:30", "10:03:00"), gap("11:00:00", "11:01:00")],
          at("16:15:59.999")
        )
      ).toEqual([[at("10:01:00"), at("10:02:00")], [at("11:00:00")]])
    })
  )

  it.effect("gaps that touch the same minute, or overlap, make one run", () =>
    Effect.gen(function* () {
      expect(
        yield* gapMinutes(
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
  )

  it.effect("an open gap runs to the end given", () =>
    Effect.gen(function* () {
      expect(yield* gapMinutes([gap("15:58:10")], at("16:00:30"))).toEqual([
        [at("15:58:00"), at("15:59:00"), at("16:00:00")],
      ])
    })
  )
})

describe("the replay cursor's place among the candle chart's bars", () => {
  // Bars at 10:00, 10:01 and 10:02, in seconds as the chart holds them.
  const bars = ["10:00:00", "10:01:00", "10:02:00"].map((wib) => at(wib) / 1000)

  it.effect("sits on its minute's bar at the whole minute", () =>
    Effect.gen(function* () {
      expect(yield* cursorLogical(bars, at("10:01:00"))).toBe(1)
    })
  )

  it.effect(
    "moves by the fraction of its minute gone, toward the next bar",
    () =>
      Effect.gen(function* () {
        expect(yield* cursorLogical(bars, at("10:01:30"))).toBe(1.5)
        expect(yield* cursorLogical(bars, at("10:02:45"))).toBe(2.75)
      })
  )

  it.effect(
    "with no bar of its own, sits half a bar past the last before it",
    () =>
      Effect.gen(function* () {
        expect(yield* cursorLogical(bars, at("10:07:20"))).toBe(2.5)
        expect(yield* cursorLogical(bars, at("09:58:00"))).toBe(-0.5)
      })
  )
})
