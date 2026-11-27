// The held order numbers route in the Worker entry:
// `/api/admin/order-numbers/<date>?after=<n>&limit=<n>`, ahead of TanStack
// Start. An admin's research script reads a day's held order numbers a page
// at a time; the day's trading-day Durable Object answers each page.
// Decision: held order numbers are read by admins only, uncached, from a hot day
// (apps/dashboard/docs/adr/0141-held-order-numbers-are-read-by-admins-only.md)
import { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Option, Schema } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { accountOf } from "../auth/session-account.ts"
import { ObjectPath } from "./routes.ts"

const PREFIX = "/api/admin/order-numbers/"
const CACHE = "private, no-store"

const decodeDate = Schema.decodeUnknownOption(WibDate)

const refused = (status: number, error: string, message: string) =>
  Effect.sync(() =>
    Response.json(
      { error, message },
      { status, headers: { "Cache-Control": CACHE } }
    )
  )

// Read past the cookie cache, as the admin pages' server functions read it,
// so a demotion or ban bites at once. Answers the refusal, or none for an
// admin.
const gate = Effect.fnUntraced(function* (request: Request) {
  const auth = yield* Auth
  const session = yield* auth.getSession(request.headers, { fresh: true })
  const decision = yield* decide(
    yield* accountOf(session),
    "admin.read-order-numbers",
    { feature: "admin" }
  )
  if (decision._tag === "Allow") return Option.none<Response>()
  const { reason } = decision
  return Option.some(
    yield* reason === "sign-in" || reason === "verify" || reason === "suspended"
      ? refused(401, "Unauthorized", "Sign in as an admin")
      : refused(403, "Forbidden", "Admins only")
  )
})

// A new request, so no header the client sent, its cookie included,
// reaches the object; only the query goes on, which the object checks.
const toTradingDay = Effect.fnUntraced(function* (
  day: WibDate,
  search: string
) {
  const object = (yield* WorkerEnv).TRADING_DAY.getByName(day)
  const request = new Request(
    new URL(
      `${ObjectPath.orderNumbers}${search}`,
      "https://trading-day.invalid"
    )
  )
  return yield* Effect.promise((): Promise<Response> => object.fetch(request))
})

const answer = Effect.fnUntraced(function* (request: Request, url: URL) {
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": CACHE },
    })
  const denied = yield* gate(request)
  if (Option.isSome(denied)) return denied.value
  const day = decodeDate(url.pathname.slice(PREFIX.length))
  if (Option.isNone(day))
    return yield* refused(400, "BadRequest", "No such day")
  return yield* toTradingDay(day.value, url.search)
})

// The route for a held order numbers path, or none for any other.
export const orderNumbersRoute = (request: Request) =>
  Effect.sync(() => {
    const url = new URL(request.url)
    return url.pathname.startsWith(PREFIX)
      ? Option.some(answer(request, url))
      : Option.none()
  })
