// An archive's daily cron and when it next starts a run, for alchemy.run.ts
// and the admin pages. Free of server imports, so the pages' components can
// word the schedule from it. Each archive's cron fires on the hour, every
// day, as "0 6,13 * * *" (UTC).
import { WIB_UTC_OFFSET_HOURS } from "@workspace/relay"
import { Effect } from "effect"

// The cron's hour field, as "6,13".
const hoursUtc = Effect.fnUntraced(function* (cron: string) {
  return (cron.split(" ")[1] ?? "").split(",").map(Number)
})

// "13:00 and 20:00 WIB"
export const timesWib = Effect.fnUntraced(function* (cron: string) {
  return `${(yield* hoursUtc(cron))
    .map(
      (hour) =>
        `${String((hour + WIB_UTC_OFFSET_HOURS) % 24).padStart(2, "0")}:00`
    )
    .join(" and ")} WIB`
})

const HOUR = 60 * 60 * 1000

export const nextRunOf = Effect.fnUntraced(function* (cron: string, now: Date) {
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  const hours = yield* hoursUtc(cron)
  const runs = [0, 24].flatMap((offset) =>
    hours.map((hour) => day + (offset + hour) * HOUR)
  )
  return new Date(runs.find((run) => run > now.getTime()) ?? runs[0])
})
