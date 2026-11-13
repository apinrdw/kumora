// Reading a day's broker codes status from a target (spec
// apinrdw/kumora#244, "The progress truth"): the extension asks it before
// every run on a day, and a walk resumes from it.
import {
  brokerCodesPath,
  decodeBrokerCodesStatus,
  type BrokerCodesStatus,
  type WibDate,
} from "@workspace/relay"
import { Duration, Effect, Option } from "effect"

import { FIRST_RETRY, LAST_RETRY } from "../target.ts"
import type { BrokerCodesTarget, PostOutcome } from "./poster.ts"

// The day's status, or why the target gave none: no token set, or stopped
// on a 401 or 426 until its settings change.
export type StatusOutcome = BrokerCodesStatus | Exclude<PostOutcome, "sent">

// One GET's answer; status 0 when it got none.
export type Get = (request: {
  readonly url: string
  readonly token: string
}) => Effect.Effect<{ readonly status: number; readonly body: string }>

export const fetchGet: Get = ({ url, token }) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      })
    )
    const body = yield* Effect.tryPromise(() => response.text())
    return { status: response.status, body }
  }).pipe(Effect.orElseSucceed(() => ({ status: 0, body: "" })))

// A day's status from a target, asked once; none when it answered none.
export const statusOnce = Effect.fnUntraced(function* (
  get: Get,
  target: BrokerCodesTarget,
  day: WibDate
) {
  const path = yield* brokerCodesPath(day)
  const answer = yield* get({
    url: `${target.origin}${path}`,
    token: target.token,
  })
  if (answer.status !== 200) return Option.none<BrokerCodesStatus>()
  return yield* Effect.option(decodeBrokerCodesStatus(answer.body))
})

export const makeBrokerCodesStatus = Effect.fnUntraced(function* (options: {
  // The target as its settings stand now; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly get: Get
}) {
  return {
    // Decision: a GET that fails for any reason but 401 or 426 is asked again
    // with the poster's backoff, 1 s doubling to 30 s. A 200 whose body isn't
    // this version's status means the dashboard moved on, as a 426 does.
    status: Effect.fnUntraced(function* (day: WibDate) {
      const path = yield* brokerCodesPath(day)
      let retry = FIRST_RETRY
      while (true) {
        const target = yield* options.target
        if (Option.isNone(target)) return "off" satisfies StatusOutcome
        const { origin, token } = target.value
        const answer = yield* options.get({ url: `${origin}${path}`, token })
        if (answer.status === 200)
          return yield* decodeBrokerCodesStatus(answer.body).pipe(
            Effect.orElseSucceed(
              (): StatusOutcome => "reload-extension" satisfies StatusOutcome
            )
          )
        if (answer.status === 401)
          return "rejected-token" satisfies StatusOutcome
        if (answer.status === 426)
          return "reload-extension" satisfies StatusOutcome
        yield* Effect.sleep(retry)
        retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
      }
    }),
  }
})
