import { Context, Effect, Layer } from "effect"

import type { Sweep, SweepCursor, WhalesToday } from "@/domain/trade"
import { EMPTY_WHALES_TODAY } from "@/features/radar/data"
import { RELAY_NAME } from "@/relay/routes"
import type { TradeRelay } from "@/relay/trade-relay"

/** Today's sweeps across the market. The demo layer serves an empty day; the live one asks the relay. */
export class Whales extends Context.Service<
  Whales,
  {
    readonly today: Effect.Effect<WhalesToday>
    readonly earlier: (
      beforeFirstKey: SweepCursor
    ) => Effect.Effect<ReadonlyArray<Sweep>>
  }
>()("dashboard/Whales") {
  static readonly layer = Layer.succeed(
    Whales,
    Whales.of({
      today: Effect.succeed(EMPTY_WHALES_TODAY).pipe(
        Effect.withSpan("Whales.today")
      ),
      earlier: Effect.fn("Whales.earlier")(function* () {
        return []
      }),
    })
  )

  /** The relay Durable Object, by RPC. */
  static readonly live = (binding: DurableObjectNamespace<TradeRelay>) => {
    const stub = () => binding.getByName(RELAY_NAME)
    return Layer.succeed(
      Whales,
      Whales.of({
        today: Effect.promise(() => stub().today()).pipe(
          Effect.withSpan("Whales.today")
        ),
        earlier: Effect.fn("Whales.earlier")(function* (
          beforeFirstKey: SweepCursor
        ) {
          return yield* Effect.promise(() => stub().earlier(beforeFirstKey))
        }),
      })
    )
  }
}
