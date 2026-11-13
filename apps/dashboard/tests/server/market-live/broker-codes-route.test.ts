// Spec apinrdw/kumora#244, "Dashboard: the route": the Worker entry's broker
// codes route, with a fake trading-day binding that records what reached it.
import { assert, describe, it } from "@effect/vitest"
import {
  BROKER_CODES_BATCH_LIMIT,
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  brokerCodesDay,
  encodeBrokerCodesBatch,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer, Option } from "effect"

import { brokerCodesRoute } from "@/server/market-live/broker-codes-route"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-12")
const PATH = "/api/broker-codes/2026-11-12"

interface Reached {
  readonly name: string
  readonly method: string
  readonly url: string
  readonly body: string
}

const setup = () => {
  const reached: Array<Reached> = []
  const env = Layer.succeed(WorkerEnv)({
    INGEST_TOKEN: TOKEN,
    TRADING_DAY: {
      getByName: (name: string) => ({
        fetch: (request: Request) =>
          request.text().then((body) => {
            reached.push({
              name,
              method: request.method,
              url: request.url,
              body,
            })
            return new Response('{"status":"answer"}', {
              headers: { "Cache-Control": "no-store" },
            })
          }),
      }),
    },
  } as unknown as WorkerEnv["Service"])
  const send = (
    path: string,
    init: { method?: string; token?: string; body?: string } = {}
  ) =>
    Effect.gen(function* () {
      const request = new Request(`https://kumora.test${path}`, {
        method: init.method ?? "GET",
        headers:
          init.token === undefined
            ? {}
            : { authorization: `Bearer ${init.token}` },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      // The entry's pick (entry.ts `marketLiveRoute`).
      const day = yield* brokerCodesDay(new URL(request.url).pathname)
      assert.isTrue(Option.isSome(day), path)
      return yield* brokerCodesRoute(request, Option.getOrThrow(day)).pipe(
        Effect.provide(env)
      )
    })
  return { reached, send }
}

const batch = (version: number = BrokerCodesProtocolVersion, day = DAY) =>
  encodeBrokerCodesBatch({
    version: BrokerCodesProtocolVersion,
    feed: "Ajaib",
    day,
    rows: [
      [
        TradeNumber.make("1"),
        {
          buyer: BrokerCode.make("YP"),
          buyerType: "D",
          seller: BrokerCode.make("CC"),
          sellerType: "F",
        },
      ],
    ],
  }).pipe(
    Effect.map((text) =>
      text.replace(
        `"version":${BrokerCodesProtocolVersion}`,
        `"version":${version}`
      )
    )
  )

describe("the broker codes route", () => {
  it.effect("a missing or wrong token answers 401, and reaches no day", () =>
    Effect.gen(function* () {
      const { reached, send } = yield* Effect.sync(setup)
      assert.strictEqual((yield* send(PATH)).status, 401)
      assert.strictEqual(
        (yield* send(PATH, {
          method: "POST",
          token: "wrong",
          body: yield* batch(),
        })).status,
        401
      )
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect("a batch of another version answers 426", () =>
    Effect.gen(function* () {
      const { reached, send } = yield* Effect.sync(setup)
      const response = yield* send(PATH, {
        method: "POST",
        token: TOKEN,
        body: yield* batch(BrokerCodesProtocolVersion + 1),
      })
      assert.strictEqual(response.status, 426)
      assert.deepStrictEqual(reached, [])
    })
  )

  it.effect(
    "a bad date, a batch of another day or an unread batch answers 400, and a body past the limit 413",
    () =>
      Effect.gen(function* () {
        const { reached, send } = yield* Effect.sync(setup)
        for (const path of [
          "/api/broker-codes/2026-02-30",
          "/api/broker-codes/today",
          "/api/broker-codes",
        ])
          assert.strictEqual(
            (yield* send(path, { token: TOKEN })).status,
            400,
            path
          )
        for (const body of [
          yield* batch(BrokerCodesProtocolVersion, WibDate.make("2026-11-11")),
          "not json",
        ])
          assert.strictEqual(
            (yield* send(PATH, { method: "POST", token: TOKEN, body })).status,
            400
          )
        const tooLong = yield* send(PATH, {
          method: "POST",
          token: TOKEN,
          body: `{"version":${BrokerCodesProtocolVersion},"pad":"${"x".repeat(BROKER_CODES_BATCH_LIMIT)}"}`,
        })
        assert.strictEqual(tooLong.status, 413)
        assert.deepStrictEqual(reached, [])
      })
  )

  it.effect("a POST and a GET reach the named day's object", () =>
    Effect.gen(function* () {
      const { reached, send } = yield* Effect.sync(setup)
      const body = yield* batch()
      const posted = yield* send(PATH, { method: "POST", token: TOKEN, body })
      assert.strictEqual(posted.status, 200)
      const status = yield* send(`${PATH}?after=2000`, { token: TOKEN })
      assert.strictEqual(status.status, 200)
      assert.strictEqual(status.headers.get("Cache-Control"), "no-store")
      assert.strictEqual(
        yield* Effect.promise(() => status.text()),
        '{"status":"answer"}'
      )
      assert.deepStrictEqual(reached, [
        {
          name: DAY,
          method: "POST",
          url: "https://trading-day.invalid/broker-codes",
          body,
        },
        {
          name: DAY,
          method: "GET",
          url: "https://trading-day.invalid/broker-codes?after=2000",
          body: "",
        },
      ])
    })
  )

  // The extension reaches an extra target from its service worker without a
  // host permission, so every answer carries CORS headers it can read.
  it.effect(
    "a preflight answers 204 before the token check, and every answer allows any origin",
    () =>
      Effect.gen(function* () {
        const { reached, send } = yield* Effect.sync(setup)
        const preflight = yield* send(PATH, { method: "OPTIONS" })
        assert.strictEqual(preflight.status, 204)
        const answers = [
          preflight,
          yield* send(PATH),
          yield* send(PATH, {
            method: "POST",
            token: TOKEN,
            body: yield* batch(BrokerCodesProtocolVersion + 1),
          }),
          yield* send(PATH, { method: "POST", token: TOKEN, body: "not json" }),
          yield* send(PATH, { method: "PUT", token: TOKEN }),
          yield* send(PATH, { token: TOKEN }),
        ]
        assert.deepStrictEqual(
          answers.map((answer) => [
            answer.status,
            answer.headers.get("access-control-allow-origin"),
            answer.headers.get("access-control-allow-headers"),
            answer.headers.get("access-control-allow-methods"),
          ]),
          [204, 401, 426, 400, 405, 200].map((status) => [
            status,
            "*",
            "authorization, content-type",
            "GET, POST, OPTIONS",
          ])
        )
        assert.strictEqual(reached.length, 1)
      })
  )

  it.effect("any other method answers 405", () =>
    Effect.gen(function* () {
      const { reached, send } = yield* Effect.sync(setup)
      const response = yield* send(PATH, { method: "PUT", token: TOKEN })
      assert.strictEqual(response.status, 405)
      assert.deepStrictEqual(reached, [])
    })
  )
})
