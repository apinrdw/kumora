// The calls Ajaib's post-close walks make on its API (ajaib-walk.ts,
// done-details-walk.ts): each paced through the Ajaib tab, signed with a
// token Ajaib hasn't refused, and stopped by Streaming hours or the end of
// Ajaib's window for the day.
import { Clock, DateTime, Effect, Option, Schema } from "effect"

import { jwtPayloadText } from "../jwt.ts"
import type { RequestingTab } from "../pacer.ts"
import { inStreamingHours, scheduleNow } from "./hours.ts"
import { halt, type WalkPhase } from "./run-queue.ts"

// The walk starts once Ajaib says CLOSED and the newest page
// carries valid codes, polling once a minute until then. A failed call
// mid-walk is retried in place every 10 s. See apinrdw/kumora#244, "Ajaib
// start".
export const START_POLL = "1 minute"
export const RETRY = "10 seconds"
const RETRY_MS = 10_000
// How long a 401 waits for a token Ajaib hasn't refused before the walk
// reloads the Ajaib tab, and again each time this passes.
const RELOAD_MS = 60_000

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

export const makeAjaibCalls = Effect.fnUntraced(function* (
  tab: AjaibWalkTab,
  report: (phase: WalkPhase) => Effect.Effect<void>
) {
  // The phase a token wait returns to: waiting for the close, or fetching.
  let phase = Option.none<WalkPhase>()
  const enter = Effect.fnUntraced(function* (
    step: "awaiting-close" | "fetching"
  ) {
    const next: WalkPhase = { step, since: yield* Clock.currentTimeMillis }
    phase = Option.some(next)
    yield* report(next)
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

  // The cookie's token once a 401 made the walk take it; none while the
  // page's own headers serve.
  let cookie = Option.none<string>()
  // Every token Ajaib refused this walk, so none is sent twice.
  const refused = new Set<string>()

  // A token past its JWT `exp` counts as refused and is never
  // sent. Ajaib's 401 carries no CORS headers, so the tab reads it as a
  // failed request, not a 401. 2026-11-20: an expired page token stalled the
  // walk, retried every 10 s, with 122,400 trades missing.
  const usable = Effect.fnUntraced(function* (token: string) {
    if (refused.has(token)) return false
    const expiry = Option.flatMap(yield* jwtPayloadText(token), decodeExpiry)
    const now = yield* Clock.currentTimeMillis
    return !Option.exists(expiry, ({ exp }) => exp * 1000 <= now)
  })

  // The token the next call sends: the cookie's once taken, else the page's.
  const sending = Effect.suspend(() =>
    Option.isSome(cookie) ? Effect.succeed(cookie) : pageToken
  )

  // On a 401 the walk sends the first usable token, the page's
  // headers' then the `trade_access_token` cookie's; with neither
  // it reloads the idle Ajaib tab every RELOAD_MS, which re-issues the cookie.
  // Its position is in the store, so a reload loses nothing. It never calls
  // refresh itself. 2026-11-17: a 22-hour-old token stalled the walk.
  const findToken = Effect.fnUntraced(function* () {
    const page = yield* pageToken
    if (Option.isSome(page) && (yield* usable(page.value))) {
      cookie = Option.none()
      return true
    }
    const stored = yield* cookieToken
    if (Option.isSome(stored) && (yield* usable(stored.value))) {
      cookie = stored
      return true
    }
    return false
  })
  const awaitNewToken = Effect.fnUntraced(function* (windowEnd: DateTime.Utc) {
    if (yield* findToken()) return
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
      if (yield* findToken()) break
    }
    if (Option.isSome(phase)) yield* report(phase.value)
  })

  // One call on Ajaib's API with the token `sending` gives; an expired token,
  // or a 401, waits for a usable token and sends the call with it. None when
  // the tab didn't answer.
  const call = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    while (true) {
      const sent = yield* sending
      if (Option.isSome(sent) && !(yield* usable(sent.value))) {
        yield* awaitNewToken(windowEnd)
        continue
      }
      const answer = yield* tab.request({
        _tag: "page-fetch",
        path,
        ...(Option.isSome(cookie) ? { bearer: cookie.value } : {}),
      })
      if (Option.isNone(answer) || answer.value.status !== 401) return answer
      if (Option.isSome(sent)) refused.add(sent.value)
      yield* awaitNewToken(windowEnd)
    }
  })

  return { enter, guard, call }
})
