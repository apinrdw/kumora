// Market Live's clock. On the Test stage alone, MARKET_LIVE_CLOCK_OFFSET
// shifts it, so the e2e opens the page in a chosen market phase (spec
// apinrdw/kumora#138, "The trading-day Durable Object"; apps/e2e/support/clock.ts
// sets it).
import { WorkerEnv } from "@workspace/server"
import { Clock, Effect } from "effect"

// The Clock `base` reads, `offset` ms later. Sleeps are unchanged.
const shifted = (base: Clock.Clock, offset: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset,
  currentTimeMillis: Effect.map(base.currentTimeMillis, (now) => now + offset),
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

// How far Market Live's clock runs ahead of the Worker's, in ms.
export const marketClockOffset = Effect.gen(function* () {
  const env: { readonly MARKET_LIVE_CLOCK_OFFSET?: string } = yield* WorkerEnv
  const offset = Number(env.MARKET_LIVE_CLOCK_OFFSET ?? "0")
  return Number.isFinite(offset) ? offset : 0
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
      shifted(base, offset)
    )
  })
