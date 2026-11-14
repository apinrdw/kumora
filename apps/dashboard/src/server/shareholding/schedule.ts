// When the archive cron next starts a run, for the admin page.
import { Effect } from "effect"

import { ARCHIVE_CRON } from "./start-run.ts"

// The cron's hour field, `6,13`: it fires on the hour, every day.
const HOURS_UTC = (ARCHIVE_CRON.split(" ")[1] ?? "").split(",").map(Number)

const HOUR = 60 * 60 * 1000

export const nextScheduledRun = Effect.fnUntraced(function* (now: Date) {
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  const runs = [0, 24].flatMap((offset) =>
    HOURS_UTC.map((hour) => day + (offset + hour) * HOUR)
  )
  return new Date(runs.find((run) => run > now.getTime()) ?? runs[0])
})
