// The held order numbers route's gate (ADR 0141): the handler seam's real
// Better Auth reads the session, and a fake trading-day Durable Object
// records what reached it.
import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer, Option } from "effect"

import { orderNumbersRoute } from "@/server/market-live/order-numbers-route"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  seam,
  send,
  signUp,
} from "../auth/seam.ts"

const PATH = "/api/admin/order-numbers/2026-11-27"

const setup = Effect.fnUntraced(function* () {
  const { layer, mails } = seam()
  const reached: Array<{
    readonly name: string
    readonly url: string
    readonly method: string
    readonly cookie: string | null
  }> = []
  const env = Layer.succeed(WorkerEnv)({
    TRADING_DAY: {
      getByName: (name: string) => ({
        fetch: (request: Request) => {
          reached.push({
            name,
            url: request.url,
            method: request.method,
            cookie: request.headers.get("cookie"),
          })
          return Effect.runPromise(
            Effect.sync(() =>
              Response.json(
                { rows: [[1, 900, 1001, "B"]] },
                { headers: { "Cache-Control": "private, no-store" } }
              )
            )
          )
        },
      }),
    },
  } as unknown as WorkerEnv["Service"])
  const layers = Layer.merge(layer, env)
  const get = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET"
  ) =>
    Effect.flatMap(
      orderNumbersRoute(
        new Request(`https://kumora.test${path}`, { method, headers })
      ),
      (route) => Option.getOrThrow(route)
    ).pipe(Effect.provide(layers))
  const signedIn = (email: string) =>
    Effect.gen(function* () {
      yield* signUp(email)
      return cookiesFrom(yield* send(linkIn(mails.at(-1))))
    }).pipe(Effect.provide(layer))
  return { reached, get, signedIn }
})

describe("the held order numbers route", () => {
  it.effect("signed out answers 401, and reaches no object", () =>
    Effect.gen(function* () {
      const { reached, get } = yield* setup()
      const response = yield* get(`${PATH}?after=0`)
      assert.strictEqual(response.status, 401)
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "private, no-store"
      )
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect("a member's session answers 403, and reaches no object", () =>
    Effect.gen(function* () {
      const { reached, get, signedIn } = yield* setup()
      const cookie = yield* signedIn("ayu@example.com")
      const response = yield* get(`${PATH}?after=0`, { cookie })
      assert.strictEqual(response.status, 403)
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "private, no-store"
      )
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect(
    "an admin's GET reaches the day's object with its query alone, and its answer stays private",
    () =>
      Effect.gen(function* () {
        const { reached, get, signedIn } = yield* setup()
        const cookie = yield* signedIn(ADMIN_EMAIL)
        const response = yield* get(`${PATH}?after=5000&limit=20000`, {
          cookie,
        })
        assert.strictEqual(response.status, 200)
        assert.strictEqual(
          response.headers.get("Cache-Control"),
          "private, no-store"
        )
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          rows: [[1, 900, 1001, "B"]],
        })
        assert.deepStrictEqual(reached, [
          {
            name: "2026-11-27",
            url: "https://trading-day.invalid/order-numbers?after=5000&limit=20000",
            method: "GET",
            cookie: null,
          },
        ])
      })
  )

  it.effect(
    "an admin's bad date answers 400 and another method 405, reaching no object",
    () =>
      Effect.gen(function* () {
        const { reached, get, signedIn } = yield* setup()
        const cookie = yield* signedIn(ADMIN_EMAIL)
        assert.strictEqual(
          (yield* get("/api/admin/order-numbers/2026-13-01", { cookie }))
            .status,
          400
        )
        assert.strictEqual((yield* get(PATH, { cookie }, "POST")).status, 405)
        assert.deepStrictEqual(reached, [])
      })
  )

  it.effect("answers no other path", () =>
    Effect.gen(function* () {
      const route = yield* orderNumbersRoute(
        new Request("https://kumora.test/api/admin/order-numbersx/2026-11-27")
      )
      assert.isTrue(Option.isNone(route))
    })
  )
})
