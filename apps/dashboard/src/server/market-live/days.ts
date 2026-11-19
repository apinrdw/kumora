// Market Live's recorded day GETs under `/market-live/days/*` (spec
// apinrdw/kumora#138, "The custom Worker entry and the gate" and "Recorded day
// loads"): the day strip, routed to the index Durable Object, and every other
// path to the trading-day Durable Object of the day it names, or for a cold
// day to its answer in R2 (cold-days.ts).
import {
  decodeDayStrip,
  type RecordedResource,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, Effect } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { refusal } from "../auth/refusal.ts"
import { accountOf } from "../auth/session-account.ts"
import { coldAnswer } from "./cold-days.ts"
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

// `answer` to a GET the gate lets through; the sector map's route
// (../sectors/map.ts) is gated the same way.
export const gatedRead = <E, R>(
  request: Request,
  answer: Effect.Effect<Response, E, R>
) =>
  Effect.gen(function* () {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { Allow: "GET" } })
    const denied = yield* gateRecordedDay(request).pipe(
      Effect.as(undefined),
      Effect.catchTags(refusedAnswer)
    )
    return denied ?? (yield* answer)
  })

// The origin of a request the Worker sends an object; the object reads the
// path alone.
const OBJECT_ORIGIN = "https://market-live.invalid"

// What the Worker reaches an object through.
interface ObjectStub {
  readonly fetch: (url: URL) => Promise<Response>
}

// A new request to the object, so no header the client sent, its cookie
// included, reaches it; and the object's answer carries no Set-Cookie, so a
// sealed day's answers cache in the browser.
const fromObject = (
  stub: (env: WorkerEnv["Service"]) => Effect.Effect<ObjectStub>,
  path: string
) =>
  Effect.gen(function* () {
    const object = yield* stub(yield* WorkerEnv)
    return yield* Effect.promise(() =>
      object.fetch(new URL(path, OBJECT_ORIGIN))
    )
  })

const indexStub = (env: WorkerEnv["Service"]): Effect.Effect<ObjectStub> =>
  Effect.sync(() => env.MARKET_LIVE_INDEX.getByName(DAY_INDEX))

export const dayStripRoute = (request: Request) =>
  gatedRead(request, fromObject(indexStub, DayIndexPath))

// A strip that fails to load (the index unreachable, its body cut off, or
// not understood) counts every day hot, and is asked again on the next GET.
// Decision: the Worker reads which days are cold from the day strip, kept per
// isolate for a minute: one strip GET a minute per busy isolate, reading one
// index row per recorded day. A day cold for less than that may still reach
// its object. See spec apinrdw/kumora#556, "Routing and caching".
const COLD_DAYS_KEPT_MS = 60_000

const loadColdDays = Effect.gen(function* () {
  const index = yield* indexStub(yield* WorkerEnv)
  const response = yield* Effect.tryPromise(() =>
    index.fetch(new URL(DayIndexPath, OBJECT_ORIGIN))
  )
  if (!response.ok) return undefined
  const strip = yield* decodeDayStrip(
    yield* Effect.tryPromise(() => response.text())
  )
  return new Set(strip.days.filter((day) => day.cold).map((day) => day.day))
}).pipe(
  Effect.catch((error) =>
    Effect.as(Effect.logWarning("Day strip not loaded", error), undefined)
  )
)

// The isolate's copy of the cold days: entry.ts makes one for the isolate.
export const makeColdDays = Effect.sync(() => {
  let kept: { readonly at: number; readonly days: ReadonlySet<WibDate> } = {
    at: -Infinity,
    days: new Set(),
  }
  return {
    isCold: Effect.fnUntraced(function* (date: WibDate) {
      const now = yield* Clock.currentTimeMillis
      if (now - kept.at >= COLD_DAYS_KEPT_MS) {
        const days = yield* loadColdDays
        if (days === undefined) return false
        kept = { at: now, days }
      }
      return kept.days.has(date)
    }),
  }
})

export type ColdDays = Effect.Success<typeof makeColdDays>

// `url` names `date` and `resource`. A cold day's answer comes from R2 for
// each resource cold-days.ts stores, else from the day's object.
export const recordedDayRoute = (
  request: Request,
  url: URL,
  date: WibDate,
  resource: RecordedResource,
  coldDays: ColdDays
) =>
  gatedRead(
    request,
    Effect.gen(function* () {
      if (yield* coldDays.isCold(date)) {
        const cold = yield* coldAnswer(
          (yield* WorkerEnv).DAYS_BUCKET,
          date,
          resource
        )
        if (cold !== undefined) return cold
      }
      return yield* fromObject(
        (env) => Effect.sync(() => env.TRADING_DAY.getByName(date)),
        `${url.pathname}${url.search}`
      )
    })
  )
