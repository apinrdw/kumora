// Production's broker codes poster and status reader (spec
// apinrdw/kumora#244, "The extension: targets").
import type { BrokerCodesBatch, TradeNumber, WibDate } from "@workspace/relay"
import type { Option } from "effect"
import { Effect } from "effect"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type PostOutcome,
  type Send,
} from "./poster.ts"
import {
  makeBrokerCodesStatus,
  type Get,
  type StatusOutcome,
  type StatusRefusal,
} from "./status.ts"

export const makeProductionTarget = Effect.fnUntraced(function* (options: {
  // Production as its settings stand now; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
  readonly get: Get
  // A 401 or 426 to a POST or a status read, for Production's Target state.
  readonly stop: (state: StatusRefusal) => Effect.Effect<void>
}) {
  const poster = yield* makeBrokerCodesPoster(options)
  const reader = yield* makeBrokerCodesStatus(options)
  // Decision: Production's 401 or 426 is shown over its socket's state until
  // its settings change (makeTargets in service-worker.ts), as the extra
  // target's is, since the socket can stay connected while the dashboard
  // refuses broker codes.
  const stopOn = (outcome: PostOutcome | StatusOutcome) =>
    outcome === "rejected-token" || outcome === "reload-extension"
      ? options.stop(outcome)
      : Effect.void
  return {
    post: (batch: BrokerCodesBatch) => Effect.tap(poster.post(batch), stopOn),
    status: (day: WibDate, after?: TradeNumber) =>
      Effect.tap(reader.status(day, after), stopOn),
  }
})
