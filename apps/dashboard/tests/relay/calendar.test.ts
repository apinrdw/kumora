import { describe, expect, test } from "vitest"

import {
  CALENDAR,
  calendarOutOfDate,
  nextOpen,
  phaseAt,
} from "@/relay/calendar"
import type { Calendar } from "@/relay/calendar"

const NO_LIST: Calendar = { holidays: {}, exceptions: {} }

/** An instant given in WIB. 2026-10-29 is a Thursday, 2026-10-30 a Friday. */
const wib = (date: string, time: string) =>
  Date.parse(`${date}T${time}:00+07:00`)

const THURSDAY = "2026-10-29"
const FRIDAY = "2026-10-30"
const SATURDAY = "2026-10-31"

describe("phaseAt", () => {
  test.each([
    ["08:44", "closed"],
    ["08:45", "pre-open"],
    ["09:00", "session-1"],
    ["11:59", "session-1"],
    ["12:00", "break"],
    ["13:29", "break"],
    ["13:30", "session-2"],
    ["15:49", "session-2"],
    ["15:50", "closing-auction"],
    ["16:01", "closing-auction"],
    ["16:02", "post-closing"],
    ["16:14", "post-closing"],
    ["16:15", "closed"],
  ])("Thursday %s is %s", (time, phase) => {
    expect(phaseAt(wib(THURSDAY, time), NO_LIST)).toBe(phase)
  })

  test.each([
    ["08:45", "pre-open"],
    ["11:29", "session-1"],
    ["11:30", "break"],
    ["13:59", "break"],
    ["14:00", "session-2"],
    ["15:50", "closing-auction"],
    ["16:01", "closing-auction"],
    ["16:02", "post-closing"],
    ["16:14", "post-closing"],
    ["16:15", "closed"],
  ])("Friday %s is %s", (time, phase) => {
    expect(phaseAt(wib(FRIDAY, time), NO_LIST)).toBe(phase)
  })

  test("the weekend is closed", () => {
    expect(phaseAt(wib(SATURDAY, "10:00"), NO_LIST)).toBe("closed")
  })

  test("the hours are WIB's, seven ahead of UTC", () => {
    expect(phaseAt(Date.parse("2026-10-29T02:00:00Z"), NO_LIST)).toBe(
      "session-1"
    )
    expect(phaseAt(Date.parse("2026-10-29T09:15:00Z"), NO_LIST)).toBe("closed")
  })

  test("a listed holiday is closed all day", () => {
    const calendar: Calendar = {
      holidays: { "2026": [THURSDAY] },
      exceptions: {},
    }
    expect(phaseAt(wib(THURSDAY, "10:00"), calendar)).toBe("closed")
    expect(phaseAt(wib(FRIDAY, "10:00"), calendar)).toBe("session-1")
  })

  test("a dated exception overrides that date's hours and no other", () => {
    const calendar: Calendar = {
      holidays: {},
      exceptions: {
        [THURSDAY]: [{ phase: "session-1", from: "09:00", to: "11:00" }],
      },
    }
    expect(phaseAt(wib(THURSDAY, "10:59"), calendar)).toBe("session-1")
    expect(phaseAt(wib(THURSDAY, "11:00"), calendar)).toBe("closed")
    expect(phaseAt(wib(THURSDAY, "13:30"), calendar)).toBe("closed")
    expect(phaseAt(wib(FRIDAY, "10:00"), calendar)).toBe("session-1")
  })

  test("a dated exception beats a holiday and opens a weekend", () => {
    const hours = [{ phase: "session-1", from: "09:00", to: "10:00" }] as const
    const calendar: Calendar = {
      holidays: { "2026": [THURSDAY] },
      exceptions: { [THURSDAY]: hours, [SATURDAY]: hours },
    }
    expect(phaseAt(wib(THURSDAY, "09:30"), calendar)).toBe("session-1")
    expect(phaseAt(wib(SATURDAY, "09:30"), calendar)).toBe("session-1")
  })

  test("a year with no list falls back to the weekly hours", () => {
    const calendar: Calendar = {
      holidays: { "2026": [THURSDAY] },
      exceptions: {},
    }
    expect(phaseAt(wib("2027-10-28", "10:00"), calendar)).toBe("session-1")
  })
})

describe("calendarOutOfDate", () => {
  const calendar: Calendar = { holidays: { "2026": [] }, exceptions: {} }

  test("a year with a list is in date, even an empty one", () => {
    expect(calendarOutOfDate(wib(THURSDAY, "10:00"), calendar)).toBe(false)
  })

  test("a year with no list is out of date", () => {
    expect(calendarOutOfDate(wib("2027-01-04", "10:00"), calendar)).toBe(true)
  })

  test("the year is WIB's: 2027 starts seven hours before UTC's", () => {
    expect(
      calendarOutOfDate(Date.parse("2026-12-31T16:59:00Z"), calendar)
    ).toBe(false)
    expect(
      calendarOutOfDate(Date.parse("2026-12-31T17:00:00Z"), calendar)
    ).toBe(true)
  })
})

describe("nextOpen", () => {
  test("after Thursday's close, it is Friday's pre-open", () => {
    expect(nextOpen(wib("2026-10-29", "16:30"), NO_LIST)).toBe(
      wib("2026-10-30", "08:45")
    )
  })

  test("after Friday's close, it skips the weekend", () => {
    expect(nextOpen(wib("2026-10-30", "16:15"), NO_LIST)).toBe(
      wib("2026-11-02", "08:45")
    )
  })

  test("it skips a listed holiday", () => {
    const holiday: Calendar = {
      holidays: { "2026": ["2026-10-30"] },
      exceptions: {},
    }
    expect(nextOpen(wib("2026-10-29", "16:30"), holiday)).toBe(
      wib("2026-11-02", "08:45")
    )
  })

  test("a calendar with no hours ahead gives up rather than spin", () => {
    const shut: Calendar = {
      holidays: {},
      exceptions: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          new Date(Date.UTC(2026, 9, 29 + i)).toISOString().slice(0, 10),
          [],
        ])
      ),
    }
    const from = wib("2026-10-29", "16:30")
    expect(nextOpen(from, shut)).toBe(from + 14 * 24 * 60 * 60_000)
  })
})

describe("CALENDAR", () => {
  /** The "Hari Bursa" column of IDX's Kalender Libur Bursa, January to December. */
  test.each([
    ["2026", [20, 18, 17, 21, 16, 20, 23, 19, 22, 22, 21, 20]],
    ["2027", [19, 19, 15, 22, 16, 21, 22, 21, 22, 21, 22, 21]],
  ])("%s's trading days match IDX's count per month", (year, published) => {
    const counted = Array.from({ length: 12 }, (_, month) => {
      const days = new Date(Date.UTC(Number(year), month + 1, 0)).getUTCDate()
      return Array.from({ length: days }, (__, i) => {
        const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`
        return phaseAt(wib(date, "10:00"), CALENDAR)
      }).filter((phase) => phase !== "closed").length
    })
    expect(counted).toEqual(published)
  })
})
