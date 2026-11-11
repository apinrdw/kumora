// The index of recorded days (spec apinrdw/kumora#138, "Seal and the index
// Durable Object"): one row per sealed day, written by that day's object at
// its seal, served as the day strip by one GET. day-index-object.ts adapts it
// to the single index Durable Object. Time is read only through Effect's
// Clock.
import {
  encodeRecordedDay,
  sealInstant,
  wibDateAt,
  type RecordedDay,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { Sql } from "./day-store.ts"

// Decision: the strip is cached in the browser until a minute after the next
// 17:00 WIB, when the next day seals and its row lands; a retried row can
// land later and shows on the next day's load.
const stripExpiresAfter = Effect.fnUntraced(function* (now: DateTime.Utc) {
  const today = DateTime.add(yield* sealInstant(yield* wibDateAt(now)), {
    minutes: 1,
  })
  return DateTime.isLessThan(now, today)
    ? today
    : DateTime.add(today, { days: 1 })
})

export const makeDayIndex = (sql: Sql) =>
  Effect.sync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, row TEXT NOT NULL) WITHOUT ROWID"
    )

    // A day's row, as its seal wrote it; a retried seal replaces it.
    const record = Effect.fnUntraced(function* (day: RecordedDay) {
      const encoded = yield* encodeRecordedDay(day)
      sql.exec("INSERT OR REPLACE INTO days VALUES (?, ?)", day.day, encoded)
    })

    // Every sealed day, newest first.
    const strip = Effect.gen(function* () {
      const rows = sql.exec("SELECT row FROM days ORDER BY day DESC")
      const now = yield* DateTime.now
      const expires = yield* stripExpiresAfter(now)
      const body = `{"days":[${rows.map((row) => String(row.row)).join(",")}]}`
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `private, max-age=${Math.ceil((DateTime.toEpochMillis(expires) - DateTime.toEpochMillis(now)) / 1000)}`,
        },
      })
    })

    return { record, strip }
  })
