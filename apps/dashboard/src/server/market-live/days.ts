// Market Live's recorded day GETs under `/market-live/days/*` (spec
// apinrdw/kumora#138, "Recorded day loads"), each routed to that day's
// trading-day Durable Object. Only the stock code list so far.
import type { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { accountOf } from "../auth/session-account.ts"
import { ObjectPath } from "./routes.ts"

// A signed-in account the access policy lets read recorded days. Read past
// the cookie cache, like the viewer socket's gate, so a ban bites at once.
const mayReadDays = Effect.fn("mayReadDays")(function* (request: Request) {
  const auth = yield* Auth
  const session = yield* auth.getSession(request.headers, { fresh: true })
  const decision = decide(accountOf(session), "market-live.view-recorded-day", {
    feature: "market-live",
  })
  return session !== null && decision._tag === "Allow"
})

// The page answers a 401 by sending the visitor to sign in.
const signInRequired = Effect.sync(
  () =>
    new Response(null, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    })
)

export const stockCodeListRoute = Effect.fnUntraced(function* (
  request: Request,
  date: WibDate
) {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  if (!(yield* mayReadDays(request))) return yield* signInRequired
  const env = yield* WorkerEnv
  const object = env.TRADING_DAY.getByName(date)
  // A new request, so no header the client sent reaches the object.
  return yield* Effect.promise(() =>
    object.fetch(new URL(ObjectPath.codes, "https://trading-day.invalid"))
  )
}, Effect.provide(Auth.layer))
