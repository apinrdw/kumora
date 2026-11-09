// The socket-closing after-hook reaches today's trading-day object on Market
// Live's clock, the same day the viewer sockets were routed to (spec
// apinrdw/kumora#138, "The custom Worker entry and the gate").
import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { LiveViewers } from "@/server/market-live/live-viewers"

const DAY_MS = 24 * 60 * 60 * 1000

const reachedWith = (offset: number) => {
  const reached: Array<string> = []
  const env = Layer.succeed(WorkerEnv)({
    MARKET_LIVE_CLOCK_OFFSET: String(offset),
    TRADING_DAY: {
      getByName: (name: string) => ({
        fetch: () => {
          reached.push(name)
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      }),
    },
  } as unknown as WorkerEnv["Service"])
  return { reached, layer: LiveViewers.layer.pipe(Layer.provide(env)) }
}

describe("ending live sessions", () => {
  it.effect("tells the object of today on Market Live's clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T10:00:00+07:00"))
      )
      const { reached, layer } = reachedWith(-3 * DAY_MS)
      yield* Effect.gen(function* () {
        const viewers = yield* LiveViewers
        yield* viewers.endSessions({ userId: "ayu", sessionIds: [] })
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(reached, ["2026-11-06"])
    })
  )
})
