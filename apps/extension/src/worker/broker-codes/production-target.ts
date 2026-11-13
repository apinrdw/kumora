// Production's broker codes poster and status reader (spec
// apinrdw/kumora#244, "The extension: targets").
import type { TradeNumber, WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type Send,
} from "./poster.ts"
import {
  makeBrokerCodesStatus,
  type Get,
  type StatusOutcome,
} from "./status.ts"
import type { TargetHold } from "./target-hold.ts"

export const makeProductionTarget = Effect.fnUntraced(function* (options: {
  // Production as its settings stand now; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
  readonly get: Get
  // Production's state under its settings (target-hold.ts).
  readonly hold: TargetHold
}) {
  // Decision: Production's 401 or 426 stops it until its settings change,
  // as the extra target's does, and its Target state shows it over the
  // socket's, since the socket can stay connected while the dashboard
  // refuses broker codes. See apinrdw/kumora#244, "Retries".
  const poster = yield* makeBrokerCodesPoster({
    ...options,
    refused: options.hold.refused,
    halted: options.hold.stopOf,
  })
  const reader = yield* makeBrokerCodesStatus({
    ...options,
    refused: options.hold.refused,
  })
  // The refusal Production's settings stand stopped on.
  const stopped = Effect.flatMap(options.target, (target) =>
    Option.isSome(target)
      ? options.hold.stopOf(target.value)
      : Effect.succeed(Option.none())
  )
  return {
    post: poster.post,
    status: (day: WibDate, after?: TradeNumber) =>
      Effect.flatMap(stopped, (stop) =>
        Option.isSome(stop)
          ? Effect.succeed<StatusOutcome>(stop.value)
          : reader.status(day, after)
      ),
  }
})
