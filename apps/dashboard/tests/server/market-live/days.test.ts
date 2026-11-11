// The recorded day GETs' gate (spec apinrdw/kumora#138, "The custom Worker
// entry and the gate"): the handler seam's real Better Auth reads the
// session, and fake Durable Object stubs stand in for the day's object and
// the index, recording what reached them.
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import { dayStripRoute, recordedDayRoute } from "@/server/market-live/days"

import { cookiesFrom, linkIn, seam, send, signUp } from "../auth/seam.ts"

const DAY = WibDate.make("2026-11-06")
const TAPE = "/market-live/days/2026-11-06/trades?at=1794194100000"

// A sealed answer, as the object sends it.
const SEALED = "private, max-age=31536000, immutable"

const objects = () => {
  const reached: Array<{ readonly name: string; readonly url: string }> = []
  const stub = (binding: string) => ({
    getByName: (name: string) => ({
      fetch: (url: URL) => {
        reached.push({ name: `${binding}:${name}`, url: url.href })
        return Effect.runPromise(
          Effect.succeed(
            new Response('{"trades":[]}', {
              headers: { "Cache-Control": SEALED },
            })
          )
        )
      },
    }),
  })
  const env = Layer.succeed(WorkerEnv)({
    TRADING_DAY: stub("TRADING_DAY"),
    MARKET_LIVE_INDEX: stub("MARKET_LIVE_INDEX"),
  } as unknown as WorkerEnv["Service"])
  return { reached, env }
}

const setup = Effect.fnUntraced(function* () {
  const { layer, mails } = seam()
  const { reached, env } = objects()
  const layers = Layer.merge(layer, env)
  const tape = (headers: Record<string, string> = {}, method = "GET") => {
    const request = new Request(`https://kumora.test${TAPE}`, {
      method,
      headers,
    })
    return recordedDayRoute(request, new URL(request.url), DAY).pipe(
      Effect.provide(layers)
    )
  }
  const strip = (headers: Record<string, string> = {}) =>
    dayStripRoute(
      new Request("https://kumora.test/market-live/days", { headers })
    ).pipe(Effect.provide(layers))
  const signedIn = Effect.gen(function* () {
    yield* signUp("ayu@example.com")
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  }).pipe(Effect.provide(layer))
  return { reached, tape, strip, signedIn }
})

const bodyOf = (response: Response) =>
  Effect.promise(() => response.json() as Promise<{ readonly error: string }>)

describe("a recorded day GET", () => {
  it.effect("signed out answers 401 JSON, and reaches no object", () =>
    Effect.gen(function* () {
      const { reached, tape, strip } = yield* setup()
      for (const response of [yield* tape(), yield* strip()]) {
        assert.strictEqual(response.status, 401)
        assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
        assert.strictEqual((yield* bodyOf(response)).error, "Unauthorized")
      }
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect(
    "signed in reaches the day's object with the path alone, and its sealed answer carries no cookie",
    () =>
      Effect.gen(function* () {
        const { reached, tape, strip, signedIn } = yield* setup()
        const cookie = yield* signedIn
        const response = yield* tape({ cookie })
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.headers.get("Cache-Control"), SEALED)
        assert.deepStrictEqual(response.headers.getSetCookie(), [])
        assert.strictEqual((yield* strip({ cookie })).status, 200)
        assert.deepStrictEqual(reached, [
          {
            name: "TRADING_DAY:2026-11-06",
            url: `https://market-live.invalid${TAPE}`,
          },
          {
            name: "MARKET_LIVE_INDEX:index",
            url: "https://market-live.invalid/days",
          },
        ])
      })
  )

  it.effect("anything but GET answers 405", () =>
    Effect.gen(function* () {
      const { reached, tape, signedIn } = yield* setup()
      const response = yield* tape({ cookie: yield* signedIn }, "POST")
      assert.strictEqual(response.status, 405)
      assert.deepStrictEqual(reached, [])
    })
  )
})
