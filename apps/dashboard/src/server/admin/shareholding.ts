// The shareholding archive's admin page, /admin/shareholding: the last archive
// run and Run now (spec apinrdw/kumora#303, "The admin page").
import { Conflict } from "@workspace/server"
import { DateTime, Effect, Option } from "effect"

import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { Auth } from "@/server/auth/auth"
import { decide, type Action } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf } from "@/server/auth/session-account"
import { nextScheduledRun } from "@/server/shareholding/schedule"
import {
  lastRun,
  runInProgress,
  startRun,
} from "@/server/shareholding/start-run"

const SHAREHOLDING_PATH =
  "/admin/shareholding" satisfies keyof FileRoutesByFullPath

const authorize = Effect.fnUntraced(function* (
  headers: Headers,
  action: Extract<Action, `admin.${string}-shareholding-archive`>
) {
  const auth = yield* Auth
  // Admin server functions read past the cookie cache.
  const session = yield* auth.getSession(headers, { fresh: true })
  const decision = yield* decide(yield* accountOf(session), action, {
    feature: "admin",
  })
  if (decision._tag === "Deny")
    return yield* refusal(decision.reason, SHAREHOLDING_PATH)
})

export const shareholdingArchivePage = Effect.fn("shareholdingArchivePage")(
  function* (headers: Headers) {
    yield* authorize(headers, "admin.view-shareholding-archive")
    const run = yield* lastRun
    const now = yield* DateTime.now
    return {
      lastRun: run,
      nextRun: (yield* nextScheduledRun(DateTime.toDateUtc(now))).toISOString(),
    }
  }
)

export const runArchiveNow = Effect.fn("runArchiveNow")(function* (
  headers: Headers
) {
  yield* authorize(headers, "admin.run-shareholding-archive")
  const refused = new Conflict({ message: "A run is in progress." })
  if (Option.isSome(yield* runInProgress)) return yield* refused
  const id = `admin-${DateTime.toEpochMillis(yield* DateTime.now)}`
  // Another Run now in the same millisecond took the id.
  yield* startRun(id, "admin").pipe(
    Effect.catchTag("DuplicateRunId", () => Effect.fail(refused))
  )
  return { id }
})
