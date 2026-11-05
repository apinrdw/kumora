import { describe, expect, test } from "vitest"

import { CALENDAR } from "@/relay/calendar"
import type { Calendar } from "@/relay/calendar"
import { calendarFrom } from "@/relay/calendar-override"

const THURSDAY = "2026-10-29"
const FRIDAY = "2026-10-30"

describe("calendarFrom", () => {
  test("no override is the operator's list", () => {
    expect(calendarFrom(undefined)).toBe(CALENDAR)
    expect(calendarFrom("")).toBe(CALENDAR)
  })

  test("an override is read as a whole calendar", () => {
    const calendar: Calendar = {
      holidays: { "2026": [THURSDAY] },
      exceptions: {
        [FRIDAY]: [{ phase: "session-1", from: "00:00", to: "24:00" }],
      },
    }
    expect(calendarFrom(JSON.stringify(calendar))).toEqual(calendar)
  })

  test.each([
    ["not JSON", "{", "Expected a valid JSON string"],
    ["missing its exceptions", '{"holidays":{}}', "Missing key"],
    [
      "of an unknown phase",
      '{"holidays":{},"exceptions":{"2026-10-29":[{"phase":"lunch","from":"12:00","to":"13:00"}]}}',
      '["phase"]',
    ],
  ])("an override %s throws", (_, json, message) => {
    expect(() => calendarFrom(json)).toThrow(message)
  })
})
