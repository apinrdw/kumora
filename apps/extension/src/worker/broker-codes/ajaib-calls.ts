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
import type { StallPlace, StallRecord } from "./stall-records.ts"

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
// request failed. The pacer's timeout starts when the call joins its queue,
// not when the tab is asked, so a no-answer after a long queue wait reads as
// a timeout: the pacer drops the tab's late answer, and a timeout refuses no
// token, so the walk only waits a call longer to refuse it.
const TIMEOUT_MS = Duration.toMillis(REQUEST_TIMEOUT)
// Ajaib's 401 carries no CORS headers, so the tab often reads it as a failed
// request: a token whose calls fail this many times in a row is refused.
const UNANSWERED_REFUSAL = 2

// The Ajaib web app's cookie holding its access token.
const TOKEN_COOKIE = "trade_access_token"
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/

// A token a walk call may be signed with (the glossary's Walk token): read
// from the cookie, the page or the PIN sign-in, never empty.
const WalkToken = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("WalkToken")
)
type WalkToken = typeof WalkToken.Type
const decodeWalkToken = Schema.decodeUnknownOption(WalkToken)

const Expiry = Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite }))
const decodeExpiry = Schema.decodeUnknownOption(Expiry)

export interface AjaibWalkTab extends RequestingTab {
  readonly attached: Effect.Effect<boolean>
  // Reloads the Ajaib tab, so its page signs its calls with a fresh token.
  readonly reload: Effect.Effect<void>
  // The PIN sign-in's access token, the walk token's last fallback.
  readonly signInToken: Effect.Effect<Option.Option<string>>
}

type Step = Extract<WalkPhase, { step: "awaiting-close" | "fetching" }>

export const makeAjaibCalls = Effect.fnUntraced(function* (
  tab: AjaibWalkTab,
  report: (phase: WalkPhase) => Effect.Effect<void>,
  // Where each stall's record goes (stall-records.ts), named by its walk.
  stalls: {
    readonly walk: StallRecord["walk"]
    readonly record?: (record: StallRecord) => Effect.Effect<void>
  }
) {
  const keepStall = stalls.record ?? (() => Effect.void)
  // The phase a token wait returns to: waiting for the close, or fetching.
  let phase = Option.none<Step>()
  // The stall cause of the call retrying in place, none once a call answers.
  let stall = Option.none<StallCause>()
  // `step` with the stall cause, if any.
  const stalled = (step: WalkPhase): WalkPhase =>
    Option.match(stall, {
      onNone: () => step,
      onSome: (cause) => ({ ...step, stall: cause }),
    })
  // Reports the phase with its stall cause, if any.
  const show = Effect.suspend(() =>
    Option.match(phase, {
      onNone: () => Effect.void,
      onSome: (step) => report(stalled(step)),
    })
  )
  const enter = Effect.fnUntraced(function* (
    step: "awaiting-close" | "fetching"
  ) {
    phase = Option.some({ step, since: yield* Clock.currentTimeMillis })
    yield* show
  })

  // Where the walk is: its day, and the tape's pass and page or the Done
  // Details code and page. A tape page also shows in the fetching phase.
  let place = Option.none<StallPlace>()
  const locate = (where: StallPlace) =>
    Effect.suspend(() => {
      place = Option.some(where)
      const { pass, page, pages } = where
      if (pass === undefined || page === undefined || pages === undefined)
        return Effect.void
      if (!Option.exists(phase, (step) => step.step === "fetching"))
        return Effect.void
      phase = Option.map(phase, (step) => ({ ...step, pass, page, pages }))
      return show
    })

  // The record of the stall in progress, kept at its first failure and at
  // each one after, so a stall the worker never ended still shows; none
  // between stalls, or before the walk says where it is.
  let open = Option.none<StallRecord>()
  const failed = Effect.fnUntraced(function* (cause: StallCause, sent: number) {
    const where = place
    if (Option.isNone(where)) return
    const before = Option.getOrElse(open, (): StallRecord => ({
      began: sent,
      ended: null,
      walk: stalls.walk,
      ...where.value,
      kind: cause.kind,
      failures: 0,
      tokenChanged: false,
      kinds: { "refused-token": 0, "no-answer": 0, timeout: 0 },
      reloads: 0,
    }))
    const record: StallRecord = {
      ...before,
      ...cause,
      kinds: { ...before.kinds, [cause.kind]: before.kinds[cause.kind] + 1 },
    }
    open = Option.some(record)
    yield* keepStall(record)
  })
  // Ends the stall in progress, if any: a call answered, or the walk ended.
  const ended = Effect.suspend(() => {
    if (Option.isNone(open)) return Effect.void
    const record = open.value
    open = Option.none()
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      keepStall({ ...record, ended: now })
    )
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
      Option.flatMap(
        Option.filter(answer, (token) => token.status === 200),
        (token) => decodeWalkToken(token.body)
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
          return decodeWalkToken(JWT.exec(text)?.[0])
        }
      )
  )

  const signInToken = Effect.map(
    Effect.suspend(() => tab.signInToken),
    Option.flatMap(decodeWalkToken)
  )

  // Every refused token of this walk, so none is sent again.
  const refused = new Set<WalkToken>()

  // A token past its JWT `exp` is refused before it is sent.
  // 2026-11-20: an expired page token stalled the walk, retried every 10 s,
  // with 122,400 trades missing.
  const usable = Effect.fnUntraced(function* (token: WalkToken) {
    if (refused.has(token)) return false
    const expiry = Option.flatMap(yield* jwtPayloadText(token), decodeExpiry)
    const now = yield* Clock.currentTimeMillis
    return !Option.exists(expiry, ({ exp }) => exp * 1000 <= now)
  })

  // The walk token, read afresh for each call: the cookie's, else the
  // page's own, else the PIN sign-in's, the first of them not refused. Ajaib
  // rotates the cookie's token, so reading it only after a 401 kept sending
  // a stale one. A reloaded page holds no token until it makes a call.
  const walkToken = Effect.fnUntraced(function* () {
    for (const read of [cookieToken, pageToken, signInToken]) {
      const token = yield* read
      if (Option.isSome(token) && (yield* usable(token.value))) return token
    }
    return Option.none<WalkToken>()
  })

  // With no token it may send, the walk reloads the idle Ajaib tab every
  // RELOAD_MS, which re-issues the cookie, until a usable token appears.
  // Its position is in the store, so a reload loses nothing. It never calls
  // refresh itself. 2026-11-17: a 22-hour-old token stalled the walk.
  const awaitToken = Effect.fnUntraced(function* (windowEnd: DateTime.Utc) {
    const now = yield* walkToken()
    if (Option.isSome(now)) return now.value
    const since = yield* Clock.currentTimeMillis
    yield* report(stalled({ step: "awaiting-token", since, reloads: 0 }))
    let waited = 0
    let reloads = 0
    while (true) {
      yield* Effect.sleep(RETRY)
      waited += RETRY_MS
      if (waited >= RELOAD_MS) {
        yield* tab.reload
        waited = 0
        reloads++
        open = Option.map(open, (record) => ({
          ...record,
          reloads: record.reloads + 1,
        }))
        if (Option.isSome(open)) yield* keepStall(open.value)
        yield* report(stalled({ step: "awaiting-token", since, reloads }))
      }
      yield* guard(windowEnd)
      const token = yield* walkToken()
      if (Option.isNone(token)) continue
      yield* show
      return token.value
    }
  })

  // One call sent with `token`: Ajaib's answer, or why it failed: Ajaib
  // refused its token with a 401, the tab answered that the request failed
  // (no status), or the tab didn't answer in time.
  const attempt = (
    path: string,
    token: WalkToken
  ): Effect.Effect<Answer | StallCause["kind"]> =>
    Effect.gen(function* () {
      const sent = yield* Clock.currentTimeMillis
      const answer = yield* tab.request({
        _tag: "page-fetch",
        path,
        bearer: token,
      })
      if (Option.isSome(answer))
        return answer.value.status === 401 ? "refused-token" : answer.value
      const took = (yield* Clock.currentTimeMillis) - sent
      return took >= TIMEOUT_MS ? "timeout" : "no-answer"
    })

  // One call on Ajaib's API, signed with the walk token and retried in place
  // until the tab answers it. A refused token is retried at once with the
  // next walk token; a call the tab didn't answer, every RETRY.
  const retried = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    // The token sent last, and how many calls in a row with it got no answer.
    let last = Option.none<WalkToken>()
    let unanswered = 0
    // The token of the first call in a row that failed, and how many have.
    let first = Option.none<WalkToken>()
    let failures = 0
    while (true) {
      const token = yield* awaitToken(windowEnd)
      if (!Option.contains(last, token)) unanswered = 0
      last = Option.some(token)
      const sent = yield* Clock.currentTimeMillis
      const outcome = yield* attempt(path, token)
      if (typeof outcome !== "string") {
        if (Option.isSome(stall)) {
          stall = Option.none()
          yield* show
        }
        return outcome
      }
      if (Option.isNone(first)) first = Option.some(token)
      failures++
      const cause: StallCause = {
        kind: outcome,
        failures,
        tokenChanged: !Option.contains(first, token),
      }
      stall = Option.some(cause)
      yield* failed(cause, sent)
      yield* show
      // Only calls in a row that got no answer refuse a token.
      unanswered = outcome === "no-answer" ? unanswered + 1 : 0
      if (outcome === "refused-token" || unanswered >= UNANSWERED_REFUSAL) {
        refused.add(token)
        continue
      }
      yield* Effect.sleep(RETRY)
      yield* guard(windowEnd)
    }
  })
  // A stall ends with its call's answer, or with the walk: halted, or
  // interrupted by a Pause or a new run. A worker stopped mid-stall leaves
  // its record open.
  const call = (windowEnd: DateTime.Utc, path: string) =>
    Effect.ensuring(retried(windowEnd, path), ended)

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

  return { enter, locate, guard, call, readPage }
})
