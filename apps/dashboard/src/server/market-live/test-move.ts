// The Test stage's move route: `POST /market-live/test-move/<date>`, the
// ingest token as its bearer, moves that sealed day to R2 at once
// (cold-days.ts), so the e2e replays a cold day. Only the Test stage binds
// MARKET_LIVE_TEST_MOVES (alchemy.run.ts); elsewhere the route answers 404.
// Until #581's alarm chain moves days itself.
import { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema } from "effect"

import { authorized } from "./broker-codes-route.ts"
import { noStoreAnswer } from "./broker-codes.ts"
import type { ColdTarget } from "./cold-days.ts"
import {
  DAY_INDEX,
  DayIndexColdPath,
  ObjectPath,
  TestMovePath,
} from "./routes.ts"

const decodeDate = Schema.decodeUnknownOption(WibDate)

// The index didn't take the cold mark; the move stays retryable.
class IndexRefusedCold extends Schema.TaggedError<IndexRefusedCold>()(
  "IndexRefusedCold",
  { status: Schema.Int }
) {}

// Marks `date` cold in the day index, once its manifest is written.
const markCold = Effect.fnUntraced(function* (date: WibDate) {
  const env = yield* WorkerEnv
  const index = env.MARKET_LIVE_INDEX.getByName(DAY_INDEX)
  const response = yield* Effect.tryPromise(() =>
    index.fetch(new URL(DayIndexColdPath, "https://day-index.invalid"), {
      method: "POST",
      body: date,
    })
  )
  if (!response.ok)
    return yield* new IndexRefusedCold({ status: response.status })
})

// The object's answer: 204 once the day moved, 409 while it isn't sealed.
export const objectMove = Effect.fnUntraced(function* (
  date: WibDate,
  move: (target: ColdTarget) => Effect.Effect<boolean, unknown, WorkerEnv>
) {
  const env = yield* WorkerEnv
  const moved = yield* move({
    bucket: env.DAYS_BUCKET,
    markCold: markCold(date),
  })
  return moved
    ? new Response(null, { status: 204 })
    : yield* noStoreAnswer(409, "Day not sealed")
})

// The Worker's route for a path under TestMovePath.
export const testMoveRoute = Effect.fnUntraced(function* (
  request: Request,
  pathname: string
) {
  const env = yield* WorkerEnv
  if (env.MARKET_LIVE_TEST_MOVES === undefined)
    return yield* noStoreAnswer(404, "Not found")
  if (!(yield* authorized(request)))
    return yield* noStoreAnswer(401, "Bad token")
  if (request.method !== "POST")
    return yield* noStoreAnswer(405, "POST", { Allow: "POST" })
  const date = decodeDate(pathname.slice(TestMovePath.length))
  if (date._tag === "None") return yield* noStoreAnswer(400, "No such day")
  const object = env.TRADING_DAY.getByName(date.value)
  return yield* Effect.promise((): Promise<Response> =>
    object.fetch(
      new Request(new URL(ObjectPath.move, "https://trading-day.invalid"), {
        method: "POST",
      })
    )
  )
})
