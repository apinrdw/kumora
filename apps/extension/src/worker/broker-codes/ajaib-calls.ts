// The calls Ajaib's post-close walks make on its API (ajaib-walk.ts,
// done-details-walk.ts): each paced through the Ajaib tab, signed with the
// walk token, retried in place until the tab answers, and stopped by
// Streaming hours or the end of Ajaib's window for the day.
import { Clock, DateTime, Duration, Effect, Option, Schema } from "effect"

import type { Answer } from "../broker.ts"
import { jwtPayloadText } from "../jwt.ts"
import type { RequestingTab } from "../pacer.ts"
import { REQUEST_TIMEOUT } from "../tab.ts"
import { inStreamingHours, scheduleNow } from "./hours.ts"
import { halt, type StallCause, type WalkPhase } from "./run-queue.ts"

// The walk starts once Ajaib says CLOSED and the newest page
// carries valid codes, polling once a minute until then. A failed call
// mid-walk is retried in place every 10 s. See apinrdw/kumora#244, "Ajaib
// start".
export const START_POLL = "1 minute"
const RETRY = "10 seconds"
const RETRY_MS = 10_000
// How long the walk waits for a token it may send before it reloads the
// Ajaib tab, and again each time this passes.
const RELOAD_MS = 60_000
// A call that comes back empty this long after it was sent timed out (the
// pacer gives it up at REQUEST_TIMEOUT); sooner, the tab answered that the
// request failed.
const TIMEOUT_MS = Duration.toMillis(REQUEST_TIMEOUT)
// Ajaib's 401 carries no CORS headers, so the tab often reads it as a failed
// request: a token whose calls fail this many times in a row is refused.
const UNANSWERED_REFUSAL = 2

// The Ajaib web app's cookie holding its access token.
const TOKEN_COOKIE = "trade_access_token"
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/

const Expiry = Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite }))
const decodeExpiry = Schema.decodeUnknownOption(Expiry)

export interface AjaibWalkTab extends RequestingTab {
  readonly attached: Effect.Effect<boolean>
  // Reloads the Ajaib tab, so its page signs its calls with a fresh token.
  readonly reload: Effect.Effect<void>
}

// Why a call failed: Ajaib refused its token with a 401, the tab answered
// that the request failed (no status), or the tab didn't answer in time.
type Failure = StallCause["kind"]

type Step = Extract<WalkPhase, { step: "awaiting-close" | "fetching" }>

export const makeAjaibCalls = Effect.fnUntraced(function* (
  tab: AjaibWalkTab,
  report: (phase: WalkPhase) => Effect.Effect<void>
) {
  // The phase a token wait returns to: waiting for the close, or fetching.
  let phase = Option.none<Step>()
  // The stall cause of the call retrying in place, none once a call answers.
  let stall = Option.none<StallCause>()
  // Reports the phase with its stall cause, if any.
  const show = Effect.suspend(() =>
    Option.match(phase, {
      onNone: () => Effect.void,
      onSome: (step) =>
        report(
          Option.match(stall, {
            onNone: () => step,
            onSome: (cause) => ({ ...step, stall: cause }),
          })
        ),
    })
  )
  const enter = Effect.fnUntraced(function* (
    step: "awaiting-close" | "fetching"
  ) {
    phase = Option.some({ step, since: yield* Clock.currentTimeMillis })
    yield* show
  })

  // Before each call: Streaming hours stop the walk in place; past
  // Ajaib's window, it can no longer serve the day.
  // With no Ajaib tab relayed the walk waits in place, polling once a minute,
  // until a tab is back or the window ends; Stockbit and the older days wait
  // behind it meanwhile.
  const guard = Effect.fnUntraced(function* (windowEnd: DateTime.Utc) {
    while (true) {
      const now = yield* scheduleNow
      if (yield* inStreamingHours(now))
        return yield* halt({ _tag: "stopped", cause: "streaming-hours" })
      if (DateTime.isGreaterThanOrEqualTo(now, windowEnd))
        return yield* halt({ _tag: "unserved", reason: "window-passed" })
      if (yield* tab.attached) return
      yield* Effect.sleep(START_POLL)
    }
  })

  const pageToken = Effect.map(
    Effect.suspend(() => tab.request({ _tag: "page-token" })),
    (answer) =>
      Option.map(
        Option.filter(answer, (token) => token.status === 200),
        (token) => token.body
      )
  )

  // The token in the tab's `trade_access_token` cookie, URL-encoded and
  // sometimes wrapped, so the JWT is matched out of it.
  const cookieToken = Effect.map(
    Effect.suspend(() => tab.request({ _tag: "cookie", name: TOKEN_COOKIE })),
    (answer) =>
      Option.flatMap(
        Option.filter(answer, (cookie) => cookie.status === 200),
        (cookie) => {
          let text = cookie.body
          try {
            text = decodeURIComponent(text)
          } catch {
            // Not URL-encoded: matched as it is.
          }
          return Option.fromNullishOr(JWT.exec(text)?.[0])
        }
      )
  )

  // Every refused token of this walk, so none is sent again.
  const refused = new Set<string>()

  // A token past its JWT `exp` is refused before it is sent.
  // 2026-11-20: an expired page token stalled the walk, retried every 10 s,
  // with 122,400 trades missing.
  const usable = Effect.fnUntraced(function* (token: string) {
    if (refused.has(token)) return false
    const expiry = Option.flatMap(yield* jwtPayloadText(token), decodeExpiry)
    const now = yield* Clock.currentTimeMillis
    return !Option.exists(expiry, ({ exp }) => exp * 1000 <= now)
  })

  // The walk token, read afresh for each call: the cookie's, else the
  // page's own, the first of them not refused. Ajaib rotates the cookie's
  // token, so reading it only after a 401 kept sending a stale one.
  const walkToken = Effect.fnUntraced(function* () {
    for (const read of [cookieToken, pageToken]) {
      const token = yield* read
      if (Option.isSome(token) && (yield* usable(token.value))) return token
    }
    return Option.none<string>()
  })

  // With no token it may send, the walk reloads the idle Ajaib tab every
  // RELOAD_MS, which re-issues the cookie, until a usable token appears.
  // Its position is in the store, so a reload loses nothing. It never calls
  // refresh itself. 2026-11-17: a 22-hour-old token stalled the walk.
  const awaitToken = Effect.fnUntraced(function* (windowEnd: DateTime.Utc) {
    const now = yield* walkToken()
    if (Option.isSome(now)) return now.value
    const since = yield* Clock.currentTimeMillis
    yield* report({ step: "awaiting-token", since, reloads: 0 })
    let waited = 0
    let reloads = 0
    while (true) {
      yield* Effect.sleep(RETRY)
      waited += RETRY_MS
      if (waited >= RELOAD_MS) {
        yield* tab.reload
        waited = 0
        reloads++
        yield* report({ step: "awaiting-token", since, reloads })
      }
      yield* guard(windowEnd)
      const token = yield* walkToken()
      if (Option.isNone(token)) continue
      yield* show
      return token.value
    }
  })

  // One call sent with `token`: Ajaib's answer, or why it failed.
  const attempt = Effect.fnUntraced(function* (path: string, token: string) {
    const sent = yield* Clock.currentTimeMillis
    const answer = yield* tab.request({
      _tag: "page-fetch",
      path,
      bearer: token,
    })
    if (Option.isSome(answer))
      return answer.value.status === 401
        ? ("refused-token" satisfies Failure as Failure)
        : answer.value
    const took = (yield* Clock.currentTimeMillis) - sent
    return took >= TIMEOUT_MS ? "timeout" : "no-answer"
  })

  // One call on Ajaib's API, signed with the walk token and retried in place
  // until the tab answers it. A refused token is retried at once with the
  // next walk token; a call the tab didn't answer, every RETRY.
  const call = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    // The token sent last, and how many calls in a row with it got no answer.
    let last = ""
    let unanswered = 0
    // The token of the first call in a row that failed, and how many have.
    let first = ""
    let failures = 0
    while (true) {
      const token = yield* awaitToken(windowEnd)
      if (token !== last) unanswered = 0
      last = token
      const outcome = yield* attempt(path, token)
      if (typeof outcome !== "string") {
        if (Option.isSome(stall)) {
          stall = Option.none()
          yield* show
        }
        return outcome
      }
      if (failures === 0) first = token
      failures++
      stall = Option.some({
        kind: outcome,
        failures,
        tokenChanged: token !== first,
      })
      yield* show
      if (outcome === "no-answer") unanswered++
      if (outcome === "refused-token" || unanswered >= UNANSWERED_REFUSAL) {
        refused.add(token)
        continue
      }
      yield* Effect.sleep(RETRY)
      yield* guard(windowEnd)
    }
  })

  // One page: the call's answer as `read` takes it, made again every RETRY
  // until Ajaib answers one `read` takes.
  const readPage = Effect.fnUntraced(function* <A>(
    windowEnd: DateTime.Utc,
    path: string,
    read: (answer: Answer) => Effect.Effect<Option.Option<A>>
  ) {
    while (true) {
      yield* guard(windowEnd)
      const answer = yield* call(windowEnd, path)
      if (answer.status === 200) {
        const taken = yield* read(answer)
        if (Option.isSome(taken)) return taken.value
      }
      yield* Effect.sleep(RETRY)
    }
  })

  return { enter, guard, call, readPage }
})
