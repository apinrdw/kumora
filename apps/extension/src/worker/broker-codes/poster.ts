// Posting broker codes batches to a target (spec apinrdw/kumora#244, "The
// extension: targets"). Production drives the walks; each batch a walk
// builds goes through one poster per target.
import {
  brokerCodesPath,
  encodeBrokerCodesBatch,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { Duration, Effect, Option } from "effect"

import type { DashboardOrigin } from "../settings.ts"
import { FIRST_RETRY, LAST_RETRY } from "../target.ts"

// Where a target takes batches: its dashboard and its ingest token.
export interface BrokerCodesTarget {
  readonly origin: DashboardOrigin
  readonly token: string
}

// How a batch ended: written, no token set, or stopped on a 401 or 426 until
// the target's settings change.
export type PostOutcome = "sent" | "off" | "rejected-token" | "reload-extension"

// One POST's answer status; 0 when it got none.
export type Send = (request: {
  readonly url: string
  readonly token: string
  readonly body: string
}) => Effect.Effect<number>

export const fetchSend: Send = ({ url, token, body }) =>
  Effect.tryPromise(() =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
    })
  ).pipe(
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0)
  )

export const makeBrokerCodesPoster = Effect.fnUntraced(function* (options: {
  // The target as its settings stand now; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
}) {
  return {
    // Decision: a POST that fails for any reason but 401 or 426 is resent
    // with target.ts's backoff, 1 s doubling to 30 s; the trading-day object
    // writes a resent batch idempotently (apinrdw/kumora#193). The settings
    // are read again before each try, so a fixed token applies at once.
    post: Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
      const body = yield* Effect.orDie(encodeBrokerCodesBatch(batch))
      const path = yield* brokerCodesPath(batch.day)
      let retry = FIRST_RETRY
      while (true) {
        const target = yield* options.target
        if (Option.isNone(target)) return "off" satisfies PostOutcome
        const { origin, token } = target.value
        const status = yield* options.send({
          url: `${origin}${path}`,
          token,
          body,
        })
        if (status === 200) return "sent" satisfies PostOutcome
        if (status === 401) return "rejected-token" satisfies PostOutcome
        if (status === 426) return "reload-extension" satisfies PostOutcome
        yield* Effect.sleep(retry)
        retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
      }
    }),
  }
})
