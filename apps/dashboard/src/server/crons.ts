// Which run a cron firing starts, for the Worker entry's `scheduled`
// (src/worker.ts). It lives outside worker.ts so a test can run it without
// TanStack Start or the Workers types, and returns the Promise of the
// archive's own cron.ts, for the reason ./shareholding/cron.ts gives.
import { runKseiCron, runKseiParseCron } from "./ksei/cron.ts"
import { KSEI_CRON, KSEI_PARSE_CRON } from "./ksei/schedule.ts"
import { runSectorCron } from "./sectors/cron.ts"
import { SECTOR_CRON } from "./sectors/schedule.ts"
import { runArchiveCron, runParseCron } from "./shareholding/cron.ts"
import { PARSE_CRON } from "./shareholding/schedule.ts"

// The archive crons and the parse crons, on Production only (alchemy.run.ts).
// Each firing names its expression, which picks its handler here; any other
// expression is the shareholding archive's.
const HANDLERS = new Map([
  [KSEI_CRON, runKseiCron],
  [KSEI_PARSE_CRON, runKseiParseCron],
  [PARSE_CRON, runParseCron],
  [SECTOR_CRON, runSectorCron],
])

export const runCron = (cron: string, scheduledTime: number) =>
  (HANDLERS.get(cron) ?? runArchiveCron)(scheduledTime)
