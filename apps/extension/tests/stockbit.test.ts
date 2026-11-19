import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Option } from "effect"

import type { Answer, LocalRequest } from "../src/worker/broker.ts"
import {
  stockbitCredential,
  subscribeFrame,
  tabCredential,
  websocketKey,
} from "../src/worker/stockbit.ts"

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

// A Stockbit access token: a JWT whose payload names the user in `data.uid`.
const jwt = `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 4242 }, exp: 1 })}.c2ln`
// The token a Google sign-in keeps in `sb_social_access_token`.
const socialJwt = `${base64Url({ alg: "RS256" })}.${base64Url({ data: { uid: 4242, use: "someone" }, exp: 2 })}.c2ln`

// What `credentialStorage` holds after a Google sign-in: the user, no token.
const profileOnly = encodeURIComponent(
  JSON.stringify({
    state: { user: { id: 4242, username: "someone" } },
    version: 0,
  })
)

// A Stockbit tab with these cookies, which answers "" for any other.
const tabWith = (cookies: Readonly<Record<string, string>>) => ({
  request: (request: LocalRequest) =>
    Effect.succeed(
      request._tag === "cookie"
        ? Option.some<Answer>({
            _tag: "answer",
            id: 0,
            status: 200,
            body: cookies[request.name] ?? "",
          })
        : Option.none<Answer>()
    ),
})

describe("Stockbit's subscribe frame", () => {
  it.effect(
    "carries the user, the key, the tab's token, the whole tape, every code's channels and the indices' live prices",
    () =>
      Effect.gen(function* () {
        const frame = yield* subscribeFrame({
          credential: { accessToken: "t", userId: "42" },
          key: "k",
          codes: [StockCode.make("BBCA")],
        })
        assert.strictEqual(
          hex(frame),
          [
            // user_id (1) "42"
            "0a 02 34 32",
            // channel (2), 45 bytes:
            "12 2d",
            // order_book (2) BBCA
            "12 04 42 42 43 41",
            // running_trade_batch (5) "*"
            "2a 01 2a",
            // liveprice (6) BBCA, then IHSG, TN.IHSG and NG.IHSG
            "32 04 42 42 43 41",
            "32 04 49 48 53 47",
            "32 07 54 4e 2e 49 48 53 47",
            "32 07 4e 47 2e 49 48 53 47",
            // iepiev (7) BBCA
            "3a 04 42 42 43 41",
            // key (3) "k"
            "1a 01 6b",
            // access_token (5) "t"
            "2a 01 74",
          ].join(" ")
        )
      })
  )

  it.effect(
    "with no code list yet, subscribes the whole tape and the indices' live prices",
    () =>
      Effect.gen(function* () {
        const frame = yield* subscribeFrame({
          credential: { accessToken: "t", userId: "42" },
          key: "k",
          codes: [],
        })
        assert.strictEqual(
          hex(frame),
          [
            "0a 02 34 32",
            "12 1b",
            "2a 01 2a",
            "32 04 49 48 53 47",
            "32 07 54 4e 2e 49 48 53 47",
            "32 07 4e 47 2e 49 48 53 47",
            "1a 01 6b 2a 01 74",
          ].join(" ")
        )
      })
  )
})

describe("the tab's Stockbit credential", () => {
  it.effect("is the access token in the credentialStorage cookie", () =>
    Effect.gen(function* () {
      const cookie = encodeURIComponent(
        JSON.stringify({ accessToken: jwt, refreshToken: "never used" })
      )
      const credential = yield* stockbitCredential(cookie)
      assert.deepStrictEqual(
        credential,
        Option.some({ accessToken: jwt, userId: "4242" })
      )
    })
  )

  it.effect("is missing when the cookie holds no token", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* stockbitCredential("")))
      assert.isTrue(Option.isNone(yield* stockbitCredential("%7B%7D")))
    })
  )
})

describe("the Stockbit tab's credential", () => {
  it.effect(
    "after a Google sign-in is the token in the sb_social_access_token cookie",
    () =>
      Effect.gen(function* () {
        const credential = yield* tabCredential(
          tabWith({
            credentialStorage: profileOnly,
            sb_social_access_token: socialJwt,
          })
        )
        assert.deepStrictEqual(
          credential,
          Option.some({ accessToken: socialJwt, userId: "4242" })
        )
      })
  )

  it.effect("is credentialStorage's token when both cookies hold one", () =>
    Effect.gen(function* () {
      const credential = yield* tabCredential(
        tabWith({
          sb_social_access_token: socialJwt,
          credentialStorage: encodeURIComponent(
            JSON.stringify({ accessToken: jwt })
          ),
        })
      )
      assert.deepStrictEqual(
        credential,
        Option.some({ accessToken: jwt, userId: "4242" })
      )
    })
  )

  it.effect("is missing when neither cookie holds a token", () =>
    Effect.gen(function* () {
      const credential = yield* tabCredential(
        tabWith({ credentialStorage: profileOnly })
      )
      assert.isTrue(Option.isNone(credential))
    })
  )
})

describe("the websocket key answer", () => {
  it.effect("reads data.key", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* websocketKey('{"message":"ok","data":{"key":"abc"}}'),
        Option.some("abc")
      )
      assert.isTrue(Option.isNone(yield* websocketKey("not json")))
    })
  )
})
