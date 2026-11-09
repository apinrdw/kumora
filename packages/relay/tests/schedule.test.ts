import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import {
  WibDate,
  closedTradingDay,
  expectedStretches,
  isTradingDay,
  marketMomentAt,
  marketPhases,
  nextOpenAfter,
  sealInstant,
  wibDateAt,
} from "@workspace/relay"

// An instant written as a WIB wall-clock time.
const wib = (dateTime: string) => DateTime.makeUnsafe(`${dateTime}+07:00`)

const momentAt = (dateTime: string) => marketMomentAt(wib(dateTime))

describe("trading days", () => {
  it.effect("a weekday is a trading day unless it is a holiday", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isTradingDay(WibDate.make("2026-11-09")))
      // Weekend.
      assert.isFalse(yield* isTradingDay(WibDate.make("2026-11-14")))
      // Independence Day, a Monday.
      assert.isFalse(yield* isTradingDay(WibDate.make("2026-08-17")))
      // 31 Dec is always an exchange holiday.
      assert.isFalse(yield* isTradingDay(WibDate.make("2026-12-31")))
      assert.isFalse(yield* isTradingDay(WibDate.make("2027-12-31")))
      assert.isTrue(yield* isTradingDay(WibDate.make("2026-12-30")))
    })
  )

  // IDX's announcements give the count, so a mistyped or missing date shows.
  it.effect("2026 has 239 trading days and 2027 has 241", () =>
    Effect.gen(function* () {
      const count = Effect.fnUntraced(function* (year: number) {
        let days = 0
        const start = DateTime.makeUnsafe(`${year}-01-01T00:00:00Z`)
        for (let offset = 0; offset < 366; offset++) {
          const date = DateTime.formatIsoDate(
            DateTime.add(start, { days: offset })
          )
          if (!date.startsWith(`${year}`)) break
          if (yield* isTradingDay(WibDate.make(date))) days++
        }
        return days
      })
      assert.strictEqual(yield* count(2026), 239)
      assert.strictEqual(yield* count(2027), 241)
    })
  )

  it.effect("a year with no entry fails loudly", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(isTradingDay(WibDate.make("2028-03-01")))
      assert.strictEqual(error._tag, "ScheduleYearMissing")
      assert.strictEqual(error.year, 2028)
      // Weekends fail too: the year is unknown, not just its holidays.
      const weekend = yield* Effect.flip(momentAt("2028-01-01T10:00:00"))
      assert.strictEqual(weekend.year, 2028)
    })
  )

  it.effect("the trading day is the WIB date, not the UTC one", () =>
    Effect.gen(function* () {
      // 08:50 WIB on Monday is still Sunday in UTC.
      const moment = yield* momentAt("2026-11-09T08:50:00")
      assert.strictEqual(moment.date, "2026-11-09")
      assert.strictEqual(moment.phase, "pre-opening")
    })
  )
})

describe("market phase, Monday to Thursday", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["08:44:59", "closed", false],
    ["08:45:00", "pre-opening", false],
    ["08:57:59", "pre-opening", false],
    ["08:58:00", "pre-opening", true],
    ["08:58:59", "pre-opening", true],
    ["08:59:00", "pre-opening", false],
    ["08:59:59", "pre-opening", false],
    ["09:00:00", "session-1", true],
    ["12:00:00", "session-1", true],
    ["12:00:01", "break", false],
    ["13:29:59", "break", false],
    ["13:30:00", "session-2", true],
    ["15:49:59", "session-2", true],
    ["15:50:00", "pre-closing", false],
    ["15:59:59", "pre-closing", false],
    ["16:00:00", "pre-closing", true],
    ["16:00:59", "pre-closing", true],
    ["16:01:00", "pre-closing", false],
    ["16:01:59", "pre-closing", false],
    ["16:02:00", "post-trading", true],
    ["16:15:00", "post-trading", true],
    ["16:15:01", "closed", false],
  ]
  for (const [time, phase, expectsTrades] of cases) {
    it.effect(`${time} is ${phase}`, () =>
      Effect.gen(function* () {
        // A Thursday.
        const moment = yield* momentAt(`2026-11-12T${time}`)
        assert.strictEqual(moment.phase, phase)
        assert.strictEqual(moment.expectsTrades, expectsTrades)
      })
    )
  }
})

describe("market phase, Friday", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["09:00:00", "session-1"],
    ["11:30:00", "session-1"],
    ["11:30:01", "break"],
    ["13:30:00", "break"],
    ["13:59:59", "break"],
    ["14:00:00", "session-2"],
    ["15:49:59", "session-2"],
    ["16:00:00", "pre-closing"],
  ]
  for (const [time, phase] of cases) {
    it.effect(`${time} is ${phase}`, () =>
      Effect.gen(function* () {
        const moment = yield* momentAt(`2026-11-13T${time}`)
        assert.strictEqual(moment.phase, phase)
      })
    )
  }
})

describe("market phase on days with no trading", () => {
  it.effect("a weekday holiday is holiday all day, a weekend closed", () =>
    Effect.gen(function* () {
      const holiday = yield* momentAt("2026-12-31T10:00:00")
      assert.strictEqual(holiday.phase, "holiday")
      assert.isFalse(holiday.expectsTrades)
      assert.isFalse(holiday.streaming)
      const saturday = yield* momentAt("2026-11-14T10:00:00")
      assert.strictEqual(saturday.phase, "closed")
      assert.isFalse(saturday.streaming)
    })
  )
})

describe("streaming hours", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["2026-11-12T08:39:59", false],
    ["2026-11-12T08:40:00", true],
    ["2026-11-12T12:30:00", true],
    // Friday's longer break streams too.
    ["2026-11-13T13:45:00", true],
    ["2026-11-12T16:34:59", true],
    ["2026-11-12T16:35:00", false],
  ]
  for (const [dateTime, streaming] of cases) {
    it.effect(`${dateTime} ${streaming ? "streams" : "does not stream"}`, () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* momentAt(dateTime)).streaming, streaming)
      })
    )
  }
})

describe("seal", () => {
  it.effect("a trading day seals at 17:00 WIB", () =>
    Effect.gen(function* () {
      const seal = yield* sealInstant(WibDate.make("2026-11-09"))
      assert.strictEqual(DateTime.formatIso(seal), "2026-11-09T10:00:00.000Z")
    })
  )
})

describe("WIB date", () => {
  it.effect("turns at midnight WIB, 17:00 UTC, in any year", () =>
    Effect.gen(function* () {
      const before = yield* wibDateAt(
        DateTime.makeUnsafe("2031-03-02T16:59:59Z")
      )
      const after = yield* wibDateAt(
        DateTime.makeUnsafe("2031-03-02T17:00:00Z")
      )
      assert.deepStrictEqual([before, after], ["2031-03-02", "2031-03-03"])
    })
  )
})

describe("stretches that expect trades", () => {
  const stretchesOf = (date: string) =>
    expectedStretches(WibDate.make(date)).pipe(
      Effect.map((stretches) =>
        stretches.map(({ from, to }) => [
          DateTime.formatIso(DateTime.add(from, { hours: 7 })).slice(11, 19),
          DateTime.formatIso(DateTime.add(to, { hours: 7 })).slice(11, 19),
        ])
      )
    )

  it.effect("are the match minutes, the sessions and post-trading", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* stretchesOf("2026-11-09"), [
        ["08:58:00", "08:59:00"],
        ["09:00:00", "12:00:01"],
        ["13:30:00", "15:50:00"],
        ["16:00:00", "16:01:00"],
        ["16:02:00", "16:15:01"],
      ])
    })
  )

  it.effect("follow Friday's longer break", () =>
    Effect.gen(function* () {
      const friday = yield* stretchesOf("2026-11-13")
      assert.deepStrictEqual(friday.slice(1, 3), [
        ["09:00:00", "11:30:01"],
        ["14:00:00", "15:50:00"],
      ])
    })
  )

  it.effect("are none on a weekend or holiday", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* stretchesOf("2026-11-14"), [])
      assert.deepStrictEqual(yield* stretchesOf("2026-08-17"), [])
    })
  )
})

describe("a trading day's market phases", () => {
  const phasesOf = (date: string) =>
    marketPhases(WibDate.make(date)).pipe(
      Effect.map((phases) =>
        phases.map(({ phase, from, to }) => [
          phase,
          DateTime.formatIso(DateTime.add(from, { hours: 7 })).slice(11, 19),
          DateTime.formatIso(DateTime.add(to, { hours: 7 })).slice(11, 19),
        ])
      )
    )

  it.effect("run from pre-opening to post-trading, Friday's break longer", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* phasesOf("2026-11-09"), [
        ["pre-opening", "08:45:00", "09:00:00"],
        ["session-1", "09:00:00", "12:00:01"],
        ["break", "12:00:01", "13:30:00"],
        ["session-2", "13:30:00", "15:50:00"],
        ["pre-closing", "15:50:00", "16:02:00"],
        ["post-trading", "16:02:00", "16:15:01"],
      ])
      const friday = yield* phasesOf("2026-11-13")
      assert.deepStrictEqual(friday[2], ["break", "11:30:01", "14:00:00"])
    })
  )

  it.effect("are none on a weekend or holiday", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* phasesOf("2026-11-14"), [])
      assert.deepStrictEqual(yield* phasesOf("2026-08-17"), [])
    })
  )
})

describe("the day a shut market opens at its close", () => {
  const shownAt = (dateTime: string) =>
    closedTradingDay(wib(dateTime)).pipe(
      Effect.map((day) => (day._tag === "Some" ? day.value : undefined))
    )

  it.effect("a weekend or holiday shows the latest trading day before it", () =>
    Effect.gen(function* () {
      // Saturday and Sunday after Friday 2026-11-13.
      assert.strictEqual(yield* shownAt("2026-11-14T10:00:00"), "2026-11-13")
      assert.strictEqual(yield* shownAt("2026-11-15T23:59:59"), "2026-11-13")
      // Independence Day, a Monday: the Friday before.
      assert.strictEqual(yield* shownAt("2026-08-17T10:00:00"), "2026-08-14")
    })
  )

  it.effect("a trading day before 08:40 shows the trading day before it", () =>
    Effect.gen(function* () {
      // Monday morning: last Friday.
      assert.strictEqual(yield* shownAt("2026-11-09T08:39:59"), "2026-11-06")
      assert.strictEqual(yield* shownAt("2026-11-10T00:00:00"), "2026-11-09")
    })
  )

  it.effect("a trading day is live from 08:40 until its 17:00 seal", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* shownAt("2026-11-09T08:40:00"))
      assert.isUndefined(yield* shownAt("2026-11-09T16:59:59"))
      // Sealed: the day itself, now a recorded day.
      assert.strictEqual(yield* shownAt("2026-11-09T17:00:00"), "2026-11-09")
    })
  )

  it.effect("the next open is 08:45 of the next trading day", () =>
    Effect.gen(function* () {
      const open = (dateTime: string) =>
        nextOpenAfter(wib(dateTime)).pipe(
          Effect.map((at) => at && DateTime.formatIso(at))
        )
      assert.strictEqual(
        yield* open("2026-11-14T10:00:00"),
        "2026-11-16T01:45:00.000Z"
      )
      assert.strictEqual(
        yield* open("2026-11-09T08:00:00"),
        "2026-11-09T01:45:00.000Z"
      )
      // Past the baked schedule.
      assert.isUndefined(yield* open("2027-12-31T10:00:00"))
    })
  )
})
