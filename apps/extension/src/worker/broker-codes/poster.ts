// Posting broker codes batches to a target (spec apinrdw/kumora#244, "The
// extension: targets"). Production drives the walks; each batch a walk
// builds goes through one poster per target.
import { StageUrl } from "@workspace/deploy/stage-url"
import {
  BROKER_CODES_AUTH_SCHEME,
  brokerCodesPath,
  encodeBrokerCodesBatch,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { Duration, Effect, Option } from "effect"

import { type Settings, type TargetState } from "../settings.ts"
import { FIRST_RETRY, LAST_RETRY } from "../target.ts"

// Where a target takes batches: its dashboard and its ingest token.
export interface BrokerCodesTarget {
  readonly url: StageUrl
  readonly token: string
}

// The targets as `settings` stand: Production and the extra target, each
// none without a token.
export const brokerCodesTargets = (settings: Settings) =>
  Effect.sync(() => ({
    production: Option.some<BrokerCodesTarget>({
      url: StageUrl.make(__PRODUCTION_DASHBOARD__),
      token: settings.productionToken,
    }).pipe(Option.filter(({ token }) => token !== "")),
    extra: Option.filter(
      Option.fromNullOr(settings.extra),
      ({ token }) => token !== ""
    ),
  }))

// How a batch ended: written, no token set, or stopped on a 401 or 426 until
// the target's settings change.
export type PostOutcome =
  | "sent"
  | Extract<TargetState, "off" | "rejected-token" | "reload-extension">

// How a batch ended short of written.
export type PostStop = Exclude<PostOutcome, "sent">

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
        authorization: `${BROKER_CODES_AUTH_SCHEME}${token}`,
        "content-type": "application/json",
      },
      body,
    })
  ).pipe(
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0)
  )

export const makeBrokerCodesPoster = Effect.fnUntraced(function* (options: {
  // The target, read before each try; none without a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
  // A 401 or 426 came back on `target`, the settings the refused try used.
  readonly refused?: (
    target: BrokerCodesTarget,
    outcome: Extract<PostOutcome, "rejected-token" | "reload-extension">
  ) => Effect.Effect<void>
  // Why `target` may not be tried, asked before each try; none when it may.
  readonly halted?: (
    target: BrokerCodesTarget
  ) => Effect.Effect<Option.Option<PostStop>>
}) {
  const refused = options.refused ?? (() => Effect.void)
  const halted =
    options.halted ?? (() => Effect.succeed(Option.none<PostStop>()))
  return {
    // Decision: 401 refuses the token, 426 means reload the extension
    // (packages/relay/docs/adr/0002-broker-codes-refusals-401-refuses-the-token-426-means-reload.md)
    post: Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
      const body = yield* Effect.orDie(encodeBrokerCodesBatch(batch))
      const path = yield* brokerCodesPath(batch.day)
      let retry = FIRST_RETRY
      while (true) {
        const target = yield* options.target
        if (Option.isNone(target)) return "off" satisfies PostOutcome
        const halt = yield* halted(target.value)
        if (Option.isSome(halt)) return halt.value
        const { url, token } = target.value
        const status = yield* options.send({
          url: `${url}${path}`,
          token,
          body,
        })
        if (status === 200) return "sent" satisfies PostOutcome
        if (status === 401 || status === 426) {
          const outcome = status === 401 ? "rejected-token" : "reload-extension"
          yield* refused(target.value, outcome)
          return outcome satisfies PostOutcome
        }
        yield* Effect.sleep(retry)
        retry = Duration.min(Duration.times(retry, 2), LAST_RETRY)
      }
    }),
  }
})
