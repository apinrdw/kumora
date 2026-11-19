// Market Live's clock. On the Test stage alone, MARKET_LIVE_CLOCK_OFFSET
// shifts it, so the e2e opens the page in a chosen market phase (spec
// apinrdw/kumora#138, "The trading-day Durable Object"; apps/e2e/support/clock.ts
// sets it).
import { wibDateAt } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, DateTime, Effect, Schema } from "effect"

// The Clock `base` reads, `offset` ms later. Sleeps are unchanged.
// Its methods are the Clock interface Effect's runtime calls.
export const shiftedClock = (base: Clock.Clock, offset: number) =>
  Effect.succeed<Clock.Clock>({
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset,
    currentTimeMillis: Effect.map(
      base.currentTimeMillis,
      (now) => now + offset
    ),
    currentTimeNanosUnsafe: () =>
      base.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
    currentTimeNanos: Effect.map(
      base.currentTimeNanos,
      (now) => now + BigInt(offset) * 1_000_000n
    ),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  })

const decodeOffset = Schema.decodeUnknownEffect(Schema.FiniteFromString)

// How far Market Live's clock runs ahead of the Worker's, in ms. Only the
// Test stage binds it; a value that isn't a number is a broken Test stage, so
// it dies rather than running unshifted.
export const marketClockOffset = Effect.gen(function* () {
  const env = yield* WorkerEnv
  return yield* decodeOffset(env.MARKET_LIVE_CLOCK_OFFSET ?? "0").pipe(
    Effect.orDie
  )
})

// Runs `effect` on Market Live's clock. Fibers it forks keep that clock.
export const withMarketClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const offset = yield* marketClockOffset
    if (offset === 0) return yield* effect
    const base = yield* Clock.Clock
    return yield* Effect.provideService(
      effect,
      Clock.Clock,
      yield* shiftedClock(base, offset)
    )
  })

// Today's WIB date on Market Live's clock: the trading-day object every live
// route reaches.
export const marketToday = withMarketClock(
  Effect.flatMap(DateTime.now, wibDateAt)
)
