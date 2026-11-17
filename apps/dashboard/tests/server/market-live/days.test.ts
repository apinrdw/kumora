// The recorded day GETs' gate (spec apinrdw/kumora#138, "The custom Worker
// entry and the gate"): the handler seam's real Better Auth reads the
// session, and fake Durable Object stubs stand in for the day's object and
// the index, recording what reached them.
import { assert, describe, it } from "@effect/vitest"
import { WibDate, recordedDayRequest } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer, Option } from "effect"

import { dayStripRoute, recordedDayRoute } from "@/server/market-live/days"

import { cookiesFrom, linkIn, seam, send, signUp } from "../auth/seam.ts"

const DAY = WibDate.make("2026-11-06")
const TAPE = "/market-live/days/2026-11-06/trades?at=1794194100000"
const BROKER_CODES =
  "/market-live/days/2026-11-06/broker-codes?at=1794194100000"
const BUBBLES = "/market-live/days/2026-11-06/bubbles"

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
  const get = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET"
  ) => {
    const request = new Request(`https://kumora.test${path}`, {
      method,
      headers,
    })
    return recordedDayRoute(request, new URL(request.url), DAY).pipe(
      Effect.provide(layers)
    )
  }
  const tape = (headers: Record<string, string> = {}, method = "GET") =>
    get(TAPE, headers, method)
  const strip = (headers: Record<string, string> = {}) =>
    dayStripRoute(
      new Request("https://kumora.test/market-live/days", { headers })
    ).pipe(Effect.provide(layers))
  const signedIn = Effect.gen(function* () {
    yield* signUp("ayu@example.com")
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  }).pipe(Effect.provide(layer))
  return { reached, get, tape, strip, signedIn }
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

  it.effect(
    "for broker codes and bubbles signed out answers as the tape's, and reaches no object",
    () =>
      Effect.gen(function* () {
        const { reached, get } = yield* setup()
        for (const path of [TAPE, BROKER_CODES, BUBBLES]) {
          const response = yield* get(path)
          assert.strictEqual(response.status, 401, path)
          assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
          assert.strictEqual((yield* bodyOf(response)).error, "Unauthorized")
        }
        assert.deepStrictEqual(reached, [])
      })
  )

  it.effect(
    "for broker codes and bubbles signed in reaches the day's object with the path alone",
    () =>
      Effect.gen(function* () {
        const { reached, get, signedIn } = yield* setup()
        const cookie = yield* signedIn
        for (const path of [BROKER_CODES, BUBBLES])
          assert.strictEqual((yield* get(path, { cookie })).status, 200)
        assert.deepStrictEqual(reached, [
          {
            name: "TRADING_DAY:2026-11-06",
            url: `https://market-live.invalid${BROKER_CODES}`,
          },
          {
            name: "TRADING_DAY:2026-11-06",
            url: `https://market-live.invalid${BUBBLES}`,
          },
        ])
      })
  )

  it.effect(
    "with a bad date or a bad cursor is no recorded day GET, for broker codes as for the tape",
    () =>
      Effect.gen(function* () {
        // The entry's pick (entry.ts `marketLiveRoute`): a path it reads no
        // day and resource from goes on to TanStack Start.
        const picked = (path: string) =>
          recordedDayRequest(new URL(`https://kumora.test${path}`))
        for (const path of [TAPE, BROKER_CODES])
          assert.isTrue(Option.isSome(yield* picked(path)), path)
        for (const kind of ["trades", "broker-codes"])
          for (const path of [
            `/market-live/days/2026-11-31/${kind}?at=1794194100000`,
            `/market-live/days/latest/${kind}?at=1794194100000`,
            `/market-live/days/2026-11-06/${kind}?at=soon`,
            `/market-live/days/2026-11-06/${kind}`,
          ])
            assert.isTrue(Option.isNone(yield* picked(path)), path)
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
