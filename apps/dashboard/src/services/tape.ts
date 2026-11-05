import { Context, Effect, Layer } from "effect"

import type { Symbol } from "@/domain/symbol"
import type { LiveSymbol, RelayStatus, TapeBackfill } from "@/domain/trade"
import { DEMO_TAPES, emptyDemoTape } from "@/features/radar/demo-tape"
import { NO_CANDLES } from "@/relay/candles"
import { RELAY_NAME } from "@/relay/routes"
import type { TradeRelay } from "@/relay/trade-relay"

const DEMO_STATUS: RelayStatus = {
  source: "none",
  freshness: "demo",
  reason: null,
  upstreamEnabled: false,
  upstreamState: "disabled",
  credentialExpiresAt: null,
  ingests: 0,
  datafeed: false,
  clients: 0,
  lastTradeAt: null,
  seq: 0,
  day: null,
  symbols: 0,
  trades: 0,
  calendarOutOfDate: false,
  sweeps: 0,
  walls: 0,
  wallCoverage: [],
  thresholds: { symbols: 0, warmingUp: 0 },
  coverage: [],
}

/** The relay's backfill per symbol, and its status. The demo layer serves the fixture trades; the live one asks the relay. */
export class Tape extends Context.Service<
  Tape,
  {
    readonly backfill: (symbol: Symbol) => Effect.Effect<TapeBackfill>
    readonly liveSymbol: (symbol: Symbol) => Effect.Effect<LiveSymbol>
    readonly status: Effect.Effect<RelayStatus>
  }
>()("dashboard/Tape") {
  static readonly layer = Layer.succeed(
    Tape,
    Tape.of({
      backfill: Effect.fn("Tape.backfill")(function* (symbol: Symbol) {
        return DEMO_TAPES.get(symbol) ?? emptyDemoTape(symbol)
      }),
      liveSymbol: Effect.fn("Tape.liveSymbol")(function* (symbol: Symbol) {
        return { backfill: emptyDemoTape(symbol), candles: NO_CANDLES }
      }),
      status: Effect.succeed(DEMO_STATUS).pipe(Effect.withSpan("Tape.status")),
    })
  )

  /** The relay Durable Object, by RPC. */
  static readonly live = (binding: DurableObjectNamespace<TradeRelay>) => {
    const stub = () => binding.getByName(RELAY_NAME)
    return Layer.succeed(
      Tape,
      Tape.of({
        backfill: Effect.fn("Tape.backfill")(function* (symbol: Symbol) {
          return yield* Effect.promise(() => stub().backfill(symbol))
        }),
        liveSymbol: Effect.fn("Tape.liveSymbol")(function* (symbol: Symbol) {
          return yield* Effect.promise(() => stub().liveSymbol(symbol))
        }),
        status: Effect.promise(() => stub().status()).pipe(
          Effect.withSpan("Tape.status")
        ),
      })
    )
  }
}
