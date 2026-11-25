import { StageUrl } from "@workspace/deploy/stage-url"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema } from "effect"

// The dashboard's Stage URL, read from the DASHBOARD_URL binding that
// alchemy.run.ts sets from stageUrl. A binding that isn't one is a broken
// deploy, so a defect.
export const dashboardStageUrl = Effect.gen(function* () {
  const env = yield* WorkerEnv
  return yield* Schema.decodeUnknownEffect(StageUrl)(env.DASHBOARD_URL)
}).pipe(Effect.orDie)
