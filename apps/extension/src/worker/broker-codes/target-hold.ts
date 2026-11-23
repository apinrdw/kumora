// What a target's broker codes requests left it in under one set of
// settings, its origin and token (spec apinrdw/kumora#244, "Retries"). One
// value holds it, replaced whole when the settings change, so nothing
// outlives the settings it came from. The Target state shows it over the
// socket's state (makeTargets in service-worker.ts), and the target sends
// nothing while it holds a refusal.
import { Effect, Option } from "effect"

import type { BrokerCodesTarget, PostStop } from "./poster.ts"
import type { StatusRefusal } from "./status.ts"

// A 401 or 426, which stops the target until its settings change, or
// `retrying` while its requests fail.
type HeldState = StatusRefusal | "retrying"

interface Held {
  readonly target: Option.Option<BrokerCodesTarget>
  readonly state: Option.Option<HeldState>
}

export type TargetHold = Effect.Success<ReturnType<typeof makeTargetHold>>

export const makeTargetHold = Effect.fnUntraced(function* (
  // The held state changed.
  changed: Effect.Effect<void>
) {
  let held: Held = { target: Option.none(), state: Option.none() }

  // Whether `target` is the settings held.
  const holds = (target: BrokerCodesTarget) =>
    Effect.sync(() =>
      Option.exists(
        held.target,
        (own) => own.origin === target.origin && own.token === target.token
      )
    )

  const refusalOf = (state: Option.Option<HeldState>) =>
    Effect.sync(() =>
      Option.filter(state, (each): each is StatusRefusal => each !== "retrying")
    )

  // Moves the held state to `state`, from a request on `target`. A request
  // on other settings changes nothing, nor does anything after a refusal.
  const move = Effect.fnUntraced(function* (
    target: BrokerCodesTarget,
    state: Option.Option<HeldState>
  ) {
    if (!(yield* holds(target))) return
    if (Option.isSome(yield* refusalOf(held.state))) return
    if (Option.getOrNull(held.state) === Option.getOrNull(state)) return
    held = { ...held, state }
    yield* changed
  })

  return {
    // The settings changed: a fresh value for the new ones, none when unset
    // or without a token.
    restart: (target: Option.Option<BrokerCodesTarget>) =>
      Effect.sync(() => {
        held = { target, state: Option.none() }
      }),

    state: Effect.sync(() => held.state),

    // The settings held now, for an operation to capture as it starts.
    settings: Effect.sync(() => held.target),

    // Decision: an extra-target operation holds its settings and asks haltOf each step
    // (apps/extension/docs/adr/0009-an-extra-target-operation-stops-on-changed-settings.md)
    haltOf: (target: BrokerCodesTarget) =>
      Effect.flatMap(holds(target), (own) =>
        own
          ? Effect.map(
              refusalOf(held.state),
              (refusal): Option.Option<PostStop> => refusal
            )
          : Effect.succeed(Option.some<PostStop>("off"))
      ),

    // The refusal that stops `target`, when its settings hold one.
    stopOf: (target: BrokerCodesTarget) =>
      Effect.flatMap(holds(target), (own) =>
        own
          ? refusalOf(held.state)
          : Effect.succeed(Option.none<StatusRefusal>())
      ),

    refused: (target: BrokerCodesTarget, refusal: StatusRefusal) =>
      move(target, Option.some(refusal)),

    // A request on `target` answered `status` (0: none): retrying until one
    // goes through. Its 401 or 426 comes through `refused`.
    answered: (target: BrokerCodesTarget, status: number) =>
      status === 401 || status === 426
        ? Effect.void
        : move(
            target,
            status === 200 ? Option.none() : Option.some("retrying")
          ),
  }
})
