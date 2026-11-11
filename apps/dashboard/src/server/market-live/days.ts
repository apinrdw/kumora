// Market Live's recorded day GETs under `/market-live/days/*` (spec
// apinrdw/kumora#138, "The custom Worker entry and the gate" and "Recorded day
// loads"): the day strip, routed to the index Durable Object, and every other
// path to the trading-day Durable Object of the day it names.
import type { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { refusal } from "../auth/refusal.ts"
import { accountOf } from "../auth/session-account.ts"
import { DAY_INDEX, DayIndexPath } from "./routes.ts"

const refused = (status: 401 | 403, error: string, message: string) =>
  Effect.sync(() =>
    Response.json(
      { error, message },
      { status, headers: { "Cache-Control": "no-store" } }
    )
  )

// Decision: recorded day loads read the session through Better Auth's cookie
// cache (5 minutes), as the spec says: Play fetches the tape up to 4 times a
// second. A ban or revoke bites here within those 5 minutes; the live socket
// reads past the cache and closes at once. A denial fails with the access
// policy's refusal.
const gateRecordedDay = Effect.fn("gateRecordedDay")(function* (
  request: Request
) {
  const auth = yield* Auth
  const session = yield* auth.getSession(request.headers)
  const decision = yield* decide(
    yield* accountOf(session),
    "market-live.view-recorded-day",
    {
      feature: "market-live",
    }
  )
  if (decision._tag === "Deny")
    return yield* refusal(decision.reason, new URL(request.url).pathname)
  if (session === null)
    return yield* refusal("sign-in", new URL(request.url).pathname)
})

const refusedAnswer = {
  // Signed out, unverified, suspended or not found: the page sends the
  // visitor to sign in.
  Unauthorized: () => refused(401, "Unauthorized", "Sign in"),
  NotFound: () => refused(401, "Unauthorized", "Sign in"),
  // No access or forbidden.
  Forbidden: () => refused(403, "Forbidden", "No access to Market Live"),
}

// A new request to the object, so no header the client sent, its cookie
// included, reaches it; and the object's answer carries no Set-Cookie, so a
// sealed day's answers cache in the browser.
const gated = Effect.fnUntraced(function* (
  request: Request,
  stub: (env: WorkerEnv["Service"]) => Effect.Effect<{
    readonly fetch: (url: URL) => Promise<Response>
  }>,
  path: string
) {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  yield* gateRecordedDay(request)
  const object = yield* stub(yield* WorkerEnv)
  return yield* Effect.promise(() =>
    object.fetch(new URL(path, "https://market-live.invalid"))
  )
}, Effect.catchTags(refusedAnswer))

export const dayStripRoute = (request: Request) =>
  gated(
    request,
    (env) => Effect.sync(() => env.MARKET_LIVE_INDEX.getByName(DAY_INDEX)),
    DayIndexPath
  )

// `url` names `date` and one of its resources.
export const recordedDayRoute = (request: Request, url: URL, date: WibDate) =>
  gated(
    request,
    (env) => Effect.sync(() => env.TRADING_DAY.getByName(date)),
    `${url.pathname}${url.search}`
  )
