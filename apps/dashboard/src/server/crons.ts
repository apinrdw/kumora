// Which archive a cron firing runs, for the Worker entry's `scheduled`
// (src/worker.ts). It lives outside worker.ts so a test can run it without
// TanStack Start or the Workers types, and returns the Promise of the
// archive's own cron.ts, for the reason ./shareholding/cron.ts gives.
import { runKseiCron } from "./ksei/cron.ts"
import { KSEI_CRON } from "./ksei/schedule.ts"
import { runArchiveCron } from "./shareholding/cron.ts"

// The archive crons, on Production only (alchemy.run.ts). Each firing names
// its expression: the KSEI archive's starts a KSEI archive run, the other the
// shareholding archive's.
export const runCron = (cron: string, scheduledTime: number) =>
  cron === KSEI_CRON
    ? runKseiCron(scheduledTime)
    : runArchiveCron(scheduledTime)
