// Market Live's recorded day GETs under `/market-live/days/*` (spec
// apinrdw/kumora#138, "The custom Worker entry and the gate" and "Recorded day
// loads"): the day strip, routed to the index Durable Object, and every other
// path to the trading-day Durable Object of the day it names.
import type { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Option } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { accountOf } from "../auth/session-account.ts"
import { DAY_INDEX, DayIndexPath } from "./routes.ts"

const refused = (status: 401 | 403, error: string, message: string) =>
  Response.json(
    { error, message },
    { status, headers: { "Cache-Control": "no-store" } }
  )

// Decision: recorded day loads read the session through Better Auth's cookie
// cache (5 minutes), as the spec says: Play fetches the tape up to 4 times a
// second. A ban or revoke bites here within those 5 minutes; the live socket
// reads past the cache and closes at once. Signed out, unverified, suspended
// or not found answers 401, so the page sends the visitor to sign in; no
// access or forbidden answers 403.
const recordedDayDenial = Effect.fn("recordedDayDenial")(function* (
  request: Request
) {
  const auth = yield* Auth
  const session = yield* auth.getSession(request.headers)
  const decision = decide(accountOf(session), "market-live.view-recorded-day", {
    feature: "market-live",
  })
  if (decision._tag === "Allow" && session !== null)
    return Option.none<Response>()
  if (
    decision._tag === "Deny" &&
    (decision.reason === "no-access" || decision.reason === "forbidden")
  )
    return Option.some(refused(403, "Forbidden", "No access to Market Live"))
  return Option.some(refused(401, "Unauthorized", "Sign in"))
})

// A new request to the object, so no header the client sent, its cookie
// included, reaches it; and the object's answer carries no Set-Cookie, so a
// sealed day's answers cache in the browser.
const gated = Effect.fnUntraced(function* (
  request: Request,
  stub: (env: WorkerEnv["Service"]) => {
    readonly fetch: (url: URL) => Promise<Response>
  },
  path: string
) {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  const denial = yield* recordedDayDenial(request)
  if (Option.isSome(denial)) return denial.value
  const object = stub(yield* WorkerEnv)
  return yield* Effect.promise(() =>
    object.fetch(new URL(path, "https://market-live.invalid"))
  )
})

export const dayStripRoute = (request: Request) =>
  gated(
    request,
    (env) => env.MARKET_LIVE_INDEX.getByName(DAY_INDEX),
    DayIndexPath
  )

// `url` names `date` and one of its resources.
export const recordedDayRoute = (request: Request, url: URL, date: WibDate) =>
  gated(
    request,
    (env) => env.TRADING_DAY.getByName(date),
    `${url.pathname}${url.search}`
  )
