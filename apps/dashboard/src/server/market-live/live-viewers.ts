// What Better Auth's socket-closing after-hook (auth/options.ts) reaches:
// today's trading-day Durable Object, told which sessions an account still
// holds after a ban, revoke or delete, so it closes the account's Market Live
// pages on every other session with 4401 (spec apinrdw/kumora#138, "The
// custom Worker entry and the gate").
import { WorkerEnv } from "@workspace/server"
import { Context, Effect, Layer, Schema } from "effect"

import { marketToday } from "./market-clock.ts"
import { HeldSessions, ObjectPath } from "./routes.ts"

const encodeHeld = Schema.encodeEffect(Schema.fromJsonString(HeldSessions))

export class LiveViewers extends Context.Service<
  LiveViewers,
  {
    readonly endSessions: (held: HeldSessions) => Effect.Effect<void>
  }
>()("dashboard/server/market-live/LiveViewers") {
  static readonly layer = Layer.effect(
    LiveViewers,
    Effect.gen(function* () {
      const env = yield* WorkerEnv
      return LiveViewers.of({
        // The ban or revoke already happened, so a failure here is logged
        // and the action still answers as it did.
        endSessions: Effect.fnUntraced(
          function* (held) {
            const today = yield* marketToday.pipe(
              Effect.provideService(WorkerEnv, env)
            )
            const request = new Request(
              new URL(ObjectPath.endSessions, "https://trading-day.invalid"),
              { method: "POST", body: yield* encodeHeld(held) }
            )
            // The object logs a failure of its own.
            yield* Effect.tryPromise(() =>
              env.TRADING_DAY.getByName(today).fetch(request)
            )
          },
          Effect.catchCause((cause) =>
            Effect.logError("Live viewers not closed", cause)
          )
        ),
      })
    })
  )
}
