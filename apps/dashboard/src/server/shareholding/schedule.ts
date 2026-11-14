// The archive cron and when it next starts a run, for alchemy.run.ts and the
// admin page. Free of server imports, so the page's components can word the
// schedule from it.
import { WIB_UTC_OFFSET_HOURS } from "@workspace/relay"
import { Effect } from "effect"

// The archive cron (UTC). alchemy.run.ts sets it on Production only.
export const ARCHIVE_CRON = "0 6,13 * * *"

// The cron's hour field, `6,13`: it fires on the hour, every day.
const HOURS_UTC = (ARCHIVE_CRON.split(" ")[1] ?? "").split(",").map(Number)

// "13:00 and 20:00 WIB"
export const ARCHIVE_TIMES_WIB = `${HOURS_UTC.map(
  (hour) => `${String((hour + WIB_UTC_OFFSET_HOURS) % 24).padStart(2, "0")}:00`
).join(" and ")} WIB`

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
