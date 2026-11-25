// Reading a day's broker codes status from a target (spec
// apinrdw/kumora#244, "The progress truth"): the extension asks it before
// every run on a day, and a walk resumes from it.
import {
  BROKER_CODES_AUTH_SCHEME,
  TradeNumber,
  brokerCodesStatusPath,
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

// The status that lists the missing ranges from trade 1.
const FROM_START = TradeNumber.make("0")

// A day's status from a target, asked once, listing the missing ranges after
// `after`: the status, the target's refusal, or none when it gave no answer
// worth reading.
// Decision: 401 refuses the token, 426 means reload the extension
// (packages/relay/docs/adr/0002-broker-codes-refusals-401-refuses-the-token-426-means-reload.md)
export const askStatus = Effect.fnUntraced(function* (
  get: Get,
  target: BrokerCodesTarget,
  day: WibDate,
  after: TradeNumber = FROM_START
) {
  const path = yield* brokerCodesStatusPath(day, after)
  const answer = yield* get({
    url: `${target.url}${path}`,
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
  // A 401 or 426 came back on `target`, the settings the refused read used.
  readonly refused?: (
    target: BrokerCodesTarget,
    refusal: StatusRefusal
  ) => Effect.Effect<void>
}) {
  const refused = options.refused ?? (() => Effect.void)
  return {
    // A GET that fails for any reason but a refusal is asked again
    // with the poster's backoff, 1 s doubling to 30 s.
    status: Effect.fnUntraced(function* (
      day: WibDate,
      after: TradeNumber = FROM_START
    ) {
      let retry = FIRST_RETRY
      while (true) {
        const target = yield* options.target
        if (Option.isNone(target)) return "off" satisfies StatusOutcome
        const asked = yield* askStatus(options.get, target.value, day, after)
        if (Option.isSome(asked) && typeof asked.value === "string")
          yield* refused(target.value, asked.value)
        if (Option.isSome(asked)) return asked.value satisfies StatusOutcome
        yield* Effect.sleep(retry)
        retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
      }
    }),
  }
})
