// Reading a day's broker codes status from a target (spec
// apinrdw/kumora#244, "The progress truth"): the extension asks it before
// every run on a day, and a walk resumes from it.
import {
  BROKER_CODES_AUTH_SCHEME,
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
        headers: { authorization: `${BROKER_CODES_AUTH_SCHEME}${token}` },
        cache: "no-store",
      })
    )
    const body = yield* Effect.tryPromise(() => response.text())
    return { status: response.status, body }
  }).pipe(Effect.orElseSucceed(() => ({ status: 0, body: "" })))

// What a target refused a status read with (askStatus).
export type StatusRefusal = Extract<
  StatusOutcome,
  "rejected-token" | "reload-extension"
>

type Asked = BrokerCodesStatus | StatusRefusal

// A day's status from a target, asked once: the status, the target's
// refusal, or none when it gave no answer worth reading.
// Decision: a 401 refuses the token. A 426, or a 200 whose body isn't this
// version's status, means the dashboard moved on and the extension must be
// reloaded.
export const askStatus = Effect.fnUntraced(function* (
  get: Get,
  target: BrokerCodesTarget,
  day: WibDate
) {
  const path = yield* brokerCodesPath(day)
  const answer = yield* get({
    url: `${target.origin}${path}`,
    token: target.token,
  })
  if (answer.status === 401) return Option.some<Asked>("rejected-token")
  if (answer.status === 426) return Option.some<Asked>("reload-extension")
  if (answer.status !== 200) return Option.none<Asked>()
  return yield* decodeBrokerCodesStatus(answer.body).pipe(
    Effect.map(Option.some<Asked>),
    Effect.orElseSucceed(() => Option.some<Asked>("reload-extension"))
  )
})

// A day's status from a target, asked once; none when it answered none.
export const statusOnce = (get: Get, target: BrokerCodesTarget, day: WibDate) =>
  Effect.map(
    askStatus(get, target, day),
    Option.filter((asked) => typeof asked !== "string")
  )

export const makeBrokerCodesStatus = Effect.fnUntraced(function* (options: {
  // The target as its settings stand now; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly get: Get
}) {
  return {
    // Decision: a GET that fails for any reason but a refusal is asked again
    // with the poster's backoff, 1 s doubling to 30 s.
    status: Effect.fnUntraced(function* (day: WibDate) {
      let retry = FIRST_RETRY
      while (true) {
        const target = yield* options.target
        if (Option.isNone(target)) return "off" satisfies StatusOutcome
        const asked = yield* askStatus(options.get, target.value, day)
        if (Option.isSome(asked)) return asked.value satisfies StatusOutcome
        yield* Effect.sleep(retry)
        retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
      }
    }),
  }
})
