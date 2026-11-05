// Only the relay's Durable Object imports this: it brings Effect, which calendar.ts
// keeps out of the browser.
import { Schema } from "effect"

import { CALENDAR, PHASES } from "./calendar"
import type { Calendar } from "./calendar"

const Hours = Schema.Struct({
  phase: Schema.Literals(PHASES),
  from: Schema.String,
  to: Schema.String,
})

const CalendarJson: Schema.Codec<Calendar, string> = Schema.fromJsonString(
  Schema.Struct({
    holidays: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    exceptions: Schema.Record(Schema.String, Schema.Array(Hours)),
  })
)

const decodeCalendar = Schema.decodeUnknownSync(CalendarJson)

/**
 * The relay's calendar: `CALENDAR`, or the JSON of a whole one in `RELAY_CALENDAR`,
 * which only a local build sets, so that `scripts/drive-extension.mts` runs the same
 * on any date. A malformed one throws: a test that runs on the wrong calendar lies.
 */
export const calendarFrom = (json: string | undefined): Calendar =>
  json ? decodeCalendar(json) : CALENDAR
