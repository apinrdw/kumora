// The Test stage's move route (test-move.ts): only a stage binding
// MARKET_LIVE_TEST_MOVES answers it, and only with the ingest token; it
// reaches the named day's object at its move path.
import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import { testMoveRoute } from "@/server/market-live/test-move"

const TOKEN = "e2e-ingest-token"

const setup = (testMoves: boolean) => {
  const reached: Array<string> = []
  const env = Layer.succeed(WorkerEnv)({
    INGEST_TOKEN: TOKEN,
    ...(testMoves ? { MARKET_LIVE_TEST_MOVES: "on" } : {}),
    TRADING_DAY: {
      getByName: (name: string) => ({
        fetch: (request: Request) =>
          Effect.runPromise(
            Effect.sync(() => {
              reached.push(
                `${request.method} ${name} ${new URL(request.url).pathname}`
              )
              return new Response(null, { status: 204 })
            })
          ),
      }),
    },
  } as unknown as WorkerEnv["Service"])
  const send = (path: string, token?: string, method = "POST") => {
    const request = new Request(`https://kumora.test${path}`, {
      method,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    return testMoveRoute(request, new URL(request.url).pathname).pipe(
      Effect.provide(env)
    )
  }
  return { reached, send }
}

describe("the Test stage's move route", () => {
  it.effect("moves the named day through its object", () =>
    Effect.gen(function* () {
      const { reached, send } = setup(true)
      const response = yield* send("/market-live/test-move/2026-11-12", TOKEN)
      assert.strictEqual(response.status, 204)
      assert.deepStrictEqual(reached, ["POST 2026-11-12 /move"])
    })
  )

  it.effect("answers 404 on a stage that doesn't bind it", () =>
    Effect.gen(function* () {
      const { reached, send } = setup(false)
      const response = yield* send("/market-live/test-move/2026-11-12", TOKEN)
      assert.strictEqual(response.status, 404)
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect("refuses a bad token, a GET and a bad date", () =>
    Effect.gen(function* () {
      const { reached, send } = setup(true)
      const path = "/market-live/test-move/2026-11-12"
      assert.strictEqual((yield* send(path, "wrong")).status, 401)
      assert.strictEqual((yield* send(path, TOKEN, "GET")).status, 405)
      assert.strictEqual(
        (yield* send("/market-live/test-move/someday", TOKEN)).status,
        400
      )
      assert.deepStrictEqual(reached, [])
    })
  )
})
