// Seam (a) of spec apinrdw/kumora#138, for the stock code list: the relay's
// CodeList envelope goes in through the ingest socket, and the test reads the
// day's GET answer.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  WibDate,
  decodeStockCodeList,
  encodeIngestUp,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"

import {
  makeTradingDay,
  type PeerState,
} from "@/server/market-live/trading-day"

import recorded from "./fixtures/ajaib-code-list-2026-11-09.json"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

const relaySocket = () => {
  let state: PeerState = "new"
  return {
    send: () => Effect.void,
    close: () => Effect.void,
    state: Effect.sync(() => state),
    setState: (next: PeerState) =>
      Effect.sync(() => {
        state = next
      }),
  }
}

// A trading day whose store outlives it, as the object's storage outlives a
// restart.
const tradingDay = Effect.fnUntraced(function* (
  stored: { value: Option.Option<string> } = { value: Option.none() }
) {
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: DAY,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    codeList: {
      read: Effect.sync(() => stored.value),
      write: (text) =>
        Effect.sync(() => {
          stored.value = Option.some(text)
        }),
    },
  }).pipe(Scope.provide(scope))
  const socket = relaySocket()
  const send = Effect.fnUntraced(function* (body: string) {
    const text = yield* encodeIngestUp({
      _tag: "CodeList",
      protocolVersion: IngestProtocolVersion,
      receivedAt: DateTime.makeUnsafe("2026-11-09T01:40:00.000Z"),
      body,
    })
    yield* day.ingestMessage(socket, text).pipe(Effect.provide(env))
  })
  const relay = Effect.gen(function* () {
    const token = yield* encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
    yield* day.ingestMessage(socket, token).pipe(Effect.provide(env))
    return send
  })
  return { day, relay, stored }
})

const listOf = Effect.fnUntraced(function* (response: Response) {
  return yield* decodeStockCodeList(
    yield* Effect.promise(() => response.text())
  )
})

// 09:00 WIB on the fixture's day.
const atNine = TestClock.setTime(Date.parse("2026-11-09T02:00:00Z"))

describe("the stock code list", () => {
  it.effect("a day with no list yet answers 404, uncached", () =>
    Effect.gen(function* () {
      const { day } = yield* tradingDay()
      const response = yield* day.recorded({ _tag: "Codes" })
      assert.strictEqual(response.status, 404)
      assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
    })
  )

  it.effect(
    "the relay's Ajaib list is served with names, warrants and rights tagged",
    () =>
      Effect.gen(function* () {
        yield* atNine
        const { day, relay } = yield* tradingDay()
        const send = yield* relay
        yield* send(recorded.body)
        const response = yield* day.recorded({ _tag: "Codes" })
        assert.strictEqual(response.status, 200)
        const { codes } = yield* listOf(response)
        // Ajaib's one empty entry is dropped; the three indices are added.
        assert.lengthOf(codes, 16)
        const kindOf = (code: string) =>
          codes.find((listed) => listed.code === code)?.kind
        const byCode = new Map<string, unknown>(
          codes.map((code) => [code.code, code])
        )
        assert.deepStrictEqual(byCode.get("BBCA"), {
          code: "BBCA",
          name: "Bank Central Asia Tbk",
          kind: "share",
        })
        assert.strictEqual(kindOf("AMAG-W2"), "warrant")
        assert.deepStrictEqual(byCode.get("BAPA-W"), {
          code: "BAPA-W",
          name: "",
          kind: "warrant",
        })
        assert.strictEqual(kindOf("WIFI-R"), "right")
        assert.strictEqual(kindOf("R-LQ45X"), "share")
        assert.deepStrictEqual(byCode.get("IHSG"), {
          code: "IHSG",
          name: "IDX Composite",
          kind: "index",
        })
        assert.strictEqual(kindOf("TN.IHSG"), "index")
        assert.strictEqual(kindOf("NG.IHSG"), "index")
        // Today's list is cached until midnight WIB, 15 hours on.
        assert.strictEqual(
          response.headers.get("Cache-Control"),
          "private, max-age=54000"
        )
      })
  )

  it.effect("a past day's list is immutable, and survives a restart", () =>
    Effect.gen(function* () {
      yield* atNine
      const first = yield* tradingDay()
      yield* (yield* first.relay)(recorded.body)
      yield* TestClock.adjust("1 day")
      const restarted = yield* tradingDay(first.stored)
      const response = yield* restarted.day.recorded({ _tag: "Codes" })
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "private, max-age=31536000, immutable"
      )
      assert.lengthOf((yield* listOf(response)).codes, 16)
    })
  )

  it.effect("a later list replaces the day's earlier one", () =>
    Effect.gen(function* () {
      const { day, relay } = yield* tradingDay()
      const send = yield* relay
      yield* send(recorded.body)
      yield* send(
        JSON.stringify({
          results: [{ code: "BBCA", name: "Bank Central Asia" }],
        })
      )
      const { codes } = yield* listOf(yield* day.recorded({ _tag: "Codes" }))
      assert.deepStrictEqual(
        codes.map(({ code }) => code),
        ["BBCA", "IHSG", "TN.IHSG", "NG.IHSG"]
      )
    })
  )

  it.effect("a body that doesn't parse keeps the stored list", () =>
    Effect.gen(function* () {
      const { day, relay } = yield* tradingDay()
      const send = yield* relay
      yield* send(recorded.body)
      yield* send("<html>Service unavailable</html>")
      yield* send(JSON.stringify({ results: [{ ticker: "BBCA" }] }))
      assert.lengthOf(
        (yield* listOf(yield* day.recorded({ _tag: "Codes" }))).codes,
        16
      )
    })
  )

  it.effect("the full list, 3,406 codes, is stored whole", () =>
    Effect.gen(function* () {
      const { day, relay } = yield* tradingDay()
      const results = Array.from({ length: 3_406 }, (_, index) => ({
        code: `C${String(index).padStart(9, "0")}`,
        name: "Call Warrant ADRO DR Exp 19 Jun 23 and a long name to spare",
      }))
      yield* (yield* relay)(JSON.stringify({ results }))
      assert.lengthOf(
        (yield* listOf(yield* day.recorded({ _tag: "Codes" }))).codes,
        3_409
      )
    })
  )

  it.effect("a code list before the token closes the socket, unstored", () =>
    Effect.gen(function* () {
      const { day } = yield* tradingDay()
      const text = yield* encodeIngestUp({
        _tag: "CodeList",
        protocolVersion: IngestProtocolVersion,
        receivedAt: DateTime.makeUnsafe("2026-11-09T01:40:00.000Z"),
        body: recorded.body,
      })
      yield* day.ingestMessage(relaySocket(), text).pipe(Effect.provide(env))
      assert.strictEqual((yield* day.recorded({ _tag: "Codes" })).status, 404)
    })
  )
})
