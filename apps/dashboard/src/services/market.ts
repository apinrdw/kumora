import { Context, Effect, Layer } from "effect"

import type { MarketOverview } from "@/features/shell/schema"
import { MARKET_OVERVIEW } from "@/lib/market"

/** The shell's read model. The demo layer serves the fixture overview. */
export class Market extends Context.Service<
  Market,
  { readonly overview: Effect.Effect<MarketOverview> }
>()("dashboard/Market") {
  static readonly layer = Layer.succeed(
    Market,
    Market.of({
      overview: Effect.succeed(MARKET_OVERVIEW).pipe(
        Effect.withSpan("Market.overview")
      ),
    })
  )
}
