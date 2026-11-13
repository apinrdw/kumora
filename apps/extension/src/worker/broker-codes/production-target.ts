// Production's broker codes poster and status reader (spec
// apinrdw/kumora#244, "The extension: targets").
import type { Option } from "effect"
import { Effect } from "effect"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type Send,
} from "./poster.ts"
import {
  makeBrokerCodesStatus,
  type Get,
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
  return { post: poster.post, status: reader.status }
})
