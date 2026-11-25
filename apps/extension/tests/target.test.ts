import { assert, describe, it } from "@effect/vitest"
import { StageUrl } from "@workspace/deploy/stage-url"
import {
  EncodedIngestUp,
  IngestCloseCode,
  IngestProtocolVersion,
  StockCode,
  WibDate,
  decodeIngestUp,
  encodeIngestDown,
  type IngestDown,
} from "@workspace/relay"
import { Effect, Layer, PubSub, SubscriptionRef } from "effect"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"

import { type TargetState } from "../src/worker/settings.ts"
import { runTarget } from "../src/worker/target.ts"

type Listener = (event: Socket.WebSocketEvent) => void

// A dashboard's ingest socket: open from the start unless the test opens it,
// it keeps what the relay sends and closes when the test says.
class FakeIngest implements Socket.WebSocketLike {
  readyState: number
  readonly sent: Array<string> = []
  private readonly listeners = new Map<string, Set<Listener>>()
  constructor(
    readonly url: string,
    opened = true
  ) {
    this.readyState = opened ? 1 : 0
  }
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }
  send(data: string | Uint8Array) {
    this.sent.push(String(data))
  }
  // The dashboard sends a message down.
  receive(data: string) {
    this.emit("message", { data })
  }
  // The handshake completes.
  open() {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.emit("open", {})
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close", { code })
  }
  private emit(type: string, event: Socket.WebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const DASHBOARD = StageUrl.make("http://localhost:3001")

// `catchUp`: what every fresh socket is sent after the token. With
// `handshake`, the first socket opens only when the test says. The dashboard
// is DASHBOARD unless `url` names another.
const harness = Effect.fnUntraced(function* (options?: {
  readonly url?: StageUrl
  readonly catchUp?: ReadonlyArray<EncodedIngestUp>
  readonly handshake?: boolean
}) {
  const catchUp = options?.catchUp ?? []
  const sockets: Array<FakeIngest> = []
  const states: Array<TargetState> = []
  const down: Array<IngestDown> = []
  const envelopes = yield* PubSub.sliding<EncodedIngestUp>(16)
  const day = yield* SubscriptionRef.make(WibDate.make("2026-11-09"))
  const fiber = yield* runTarget({
    url: options?.url ?? DASHBOARD,
    token: "the token",
    envelopes,
    day,
    catchUp: () => Effect.succeed(catchUp),
    report: (state) => Effect.sync(() => states.push(state)),
    receive: (message) => Effect.sync(() => down.push(message)),
  }).pipe(
    Effect.provide(
      Layer.succeed(Socket.WebSocketConstructor)((url) => {
        const socket = new FakeIngest(
          url,
          !(options?.handshake === true && sockets.length === 0)
        )
        sockets.push(socket)
        return socket
      })
    ),
    Effect.forkScoped
  )
  // Lets the target's fibers run until they wait on the socket or the clock.
  const settle = Effect.repeat(Effect.yieldNow, { times: 20 })
  return { sockets, states, down, envelopes, day, fiber, settle }
})

describe("a target's ingest socket", () => {
  it.effect(
    "sends the token first, then every envelope published while open",
    () =>
      Effect.gen(function* () {
        const { sockets, states, envelopes, settle } = yield* harness()
        yield* settle
        yield* PubSub.publish(envelopes, EncodedIngestUp.make("envelope 1"))
        yield* settle
        assert.strictEqual(sockets.length, 1)
        assert.strictEqual(
          sockets[0]?.url,
          "ws://localhost:3001/market-live/ingest"
        )
        const token = yield* decodeIngestUp(sockets[0]?.sent[0] ?? "")
        assert.deepStrictEqual(token, {
          _tag: "Token",
          protocolVersion: IngestProtocolVersion,
          token: "the token",
        })
        assert.deepStrictEqual(sockets[0]?.sent.slice(1), ["envelope 1"])
        assert.deepStrictEqual(states, ["connecting", "connected"])
      }).pipe(Effect.scoped)
  )

  it.effect("opens under a dashboard served at a path", () =>
    Effect.gen(function* () {
      const { sockets, settle } = yield* harness({
        url: StageUrl.make("https://staging.example/dashboard"),
      })
      yield* settle
      assert.strictEqual(
        sockets[0]?.url,
        "wss://staging.example/dashboard/market-live/ingest"
      )
    }).pipe(Effect.scoped)
  )

  for (const [code, state] of [
    [IngestCloseCode.RejectedToken, "rejected-token"],
    [IngestCloseCode.VersionMismatch, "reload-extension"],
  ] as const)
    it.effect(`a ${code} close stops retrying and shows ${state}`, () =>
      Effect.gen(function* () {
        const { sockets, states, fiber, settle } = yield* harness()
        yield* settle
        sockets[0]?.close(code)
        yield* settle
        yield* TestClock.adjust("10 minutes")
        yield* settle
        assert.strictEqual(sockets.length, 1)
        assert.deepStrictEqual(states.at(-1), state)
        assert.isDefined(fiber.pollUnsafe())
      }).pipe(Effect.scoped)
    )

  it.effect(
    "any other close retries with backoff, reset once a socket opens",
    () =>
      Effect.gen(function* () {
        const { sockets, states, settle } = yield* harness()
        yield* settle
        sockets[0]?.close(1006)
        yield* settle
        assert.strictEqual(sockets.length, 1)
        assert.strictEqual(states.at(-1), "retrying")
        yield* TestClock.adjust("1 second")
        yield* settle
        assert.strictEqual(sockets.length, 2)
        assert.strictEqual(states.at(-1), "connected")
        // Opened again, so the next drop waits 1 s again, not 2 s.
        sockets[1]?.close(1006)
        yield* settle
        yield* TestClock.adjust("1 second")
        yield* settle
        assert.strictEqual(sockets.length, 3)
      }).pipe(Effect.scoped)
  )

  it.effect("sends the catch-up envelopes after the token on every open", () =>
    Effect.gen(function* () {
      const { sockets, settle } = yield* harness({
        catchUp: [EncodedIngestUp.make("the code list")],
      })
      yield* settle
      assert.deepStrictEqual(sockets[0]?.sent.slice(1), ["the code list"])
      sockets[0]?.close(1006)
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle
      assert.deepStrictEqual(sockets[1]?.sent.slice(1), ["the code list"])
    }).pipe(Effect.scoped)
  )

  it.effect(
    "reconnects at once when the WIB date changes, so the new day's object gets the frames",
    () =>
      Effect.gen(function* () {
        const { sockets, states, day, settle } = yield* harness()
        yield* settle
        yield* SubscriptionRef.set(day, WibDate.make("2026-11-10"))
        yield* settle
        assert.strictEqual(sockets[0]?.readyState, 3)
        assert.strictEqual(sockets.length, 2)
        assert.deepStrictEqual(states, [
          "connecting",
          "connected",
          "connecting",
          "connected",
        ])
      }).pipe(Effect.scoped)
  )

  it.effect(
    "reconnects when the WIB date changes during the handshake, which routed the socket to the old day's object",
    () =>
      Effect.gen(function* () {
        const { sockets, states, day, settle } = yield* harness({
          handshake: true,
        })
        yield* settle
        assert.strictEqual(sockets.length, 1)
        assert.deepStrictEqual(states, ["connecting"])
        yield* SubscriptionRef.set(day, WibDate.make("2026-11-10"))
        yield* settle
        sockets[0]?.open()
        yield* settle
        assert.strictEqual(sockets[0]?.readyState, 3)
        assert.strictEqual(sockets.length, 2)
        assert.deepStrictEqual(states, [
          "connecting",
          "connected",
          "connecting",
          "connected",
        ])
      }).pipe(Effect.scoped)
  )

  it.effect("hands on what the trading-day object sends down", () =>
    Effect.gen(function* () {
      const { sockets, down, settle } = yield* harness()
      yield* settle
      const codes: IngestDown = {
        _tag: "OnDemandCodes",
        codes: [StockCode.make("BBCA")],
      }
      sockets[0]?.receive(yield* encodeIngestDown(codes))
      sockets[0]?.receive("not a message")
      yield* settle
      assert.deepStrictEqual(down, [codes])
    }).pipe(Effect.scoped)
  )
})
