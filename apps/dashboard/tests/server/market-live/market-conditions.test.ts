// Seam (a) of spec apinrdw/kumora#138, for what viewers are told besides the
// tape: the market conditions (each feed's freshness, the market phase and
// relay gaps) and indicative prices. Envelopes go in through the ingest
// socket, TestClock moves time, and the test reads the market conditions
// viewers receive.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  ViewerProtocolVersion,
  WibDate,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type Connection,
  type Feed,
  type FrameStream,
  type IngestUp,
  type MarketConditions,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"
import { memorySql } from "./sql"
import { everySplit } from "../../interleaved"

const TOKEN = "e2e-ingest-token"
const BBCA = StockCode.make("BBCA")

class FakeSocket implements Peer {
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  isOpen = true
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
  open = Effect.sync(() => this.isOpen)
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
  received = Effect.suspend(() =>
    Effect.forEach(this.sent, (text) => decodeViewerDown(text))
  )
}

const env = Layer.succeed(WorkerEnv)({
  INGEST_TOKEN: TOKEN,
} as unknown as WorkerEnv["Service"])

// An instant written as a WIB wall-clock time.
const wib = (dateTime: string) => DateTime.makeUnsafe(`${dateTime}+07:00`)

// Today's object at `start` (WIB), a connected relay and one viewer of BBCA.
const marketAt = Effect.fnUntraced(function* (start: string) {
  yield* TestClock.setTime(DateTime.toEpochMillis(wib(start)))
  const viewers: Array<FakeSocket> = []
  const relay = new FakeSocket()
  // The object's relay sockets: this one, and any others a test adds.
  const relays: Array<FakeSocket> = [relay]
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: WibDate.make(start.slice(0, 10)),
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
  }).pipe(Scope.provide(yield* Scope.make()))
  const up = (message: IngestUp) =>
    encodeIngestUp(message).pipe(
      Effect.flatMap((text) => day.ingestMessage(relay, text)),
      Effect.provide(env)
    )
  yield* up({
    _tag: "Token",
    protocolVersion: IngestProtocolVersion,
    token: TOKEN,
  })
  const frames = (
    feed: Feed,
    connection: Connection = "A",
    content: ReadonlyArray<string | Uint8Array> = [],
    stream: FrameStream = "trade"
  ) =>
    up({
      _tag: "Frames",
      protocolVersion: IngestProtocolVersion,
      feed,
      connection,
      receivedAt: DateTime.makeUnsafe(0),
      ...(feed === "Ajaib" ? { stream } : {}),
      frames: content,
    } as IngestUp)
  const reported = (
    feed: Feed,
    connection: Connection,
    status: "closed" | "alive"
  ) =>
    up({
      _tag: "FeedStatus",
      protocolVersion: IngestProtocolVersion,
      feed,
      connection,
      at: DateTime.makeUnsafe(0),
      status,
    })
  const page = new FakeSocket()
  viewers.push(page)
  const select = (
    selected: StockCode,
    watchlist: ReadonlyArray<StockCode> = []
  ) =>
    encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected,
      watchlist,
    }).pipe(Effect.flatMap((text) => day.viewerMessage(page, text)))
  yield* select(BBCA)
  // The market conditions the viewer holds now: its snapshot's, as later
  // deltas changed them.
  const conditions = Effect.gen(function* () {
    let current: MarketConditions | undefined
    for (const message of yield* page.received)
      if (message.conditions !== undefined) current = message.conditions
    return current!
  })
  const feeds = Effect.map(conditions, (current) => current.feeds)
  // The relay socket closes.
  const relayClosed = day.ingestClosed(relay)
  // Another relay socket is accepted, listed from then on.
  const relayAccepted = Effect.sync(() => {
    const socket = new FakeSocket()
    relays.push(socket)
    return socket
  })
  // Another relay socket sends its token.
  const tokenOn = (socket: FakeSocket) =>
    encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    }).pipe(
      Effect.flatMap((text) => day.ingestMessage(socket, text)),
      Effect.provide(env)
    )
  return {
    frames,
    reported,
    conditions,
    feeds,
    relayClosed,
    relayAccepted,
    tokenOn,
    page,
    select,
  }
})

describe("the relay under overlapping callbacks", () => {
  it.effect(
    "a relay socket closing while another relay's token is being handled leaves the relay online",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.gen(function* () {
            const market = yield* marketAt("2026-11-09T10:00:00")
            yield* market.frames("Stockbit")
            return { market, other: yield* market.relayAccepted }
          }),
          first: ({ market, other }) => market.tokenOn(other),
          // The close waits for the token's turn, and the other socket is
          // counted ready by then.
          second: ({ market }) => market.relayClosed,
          check: ({ market }, at) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("250 millis")
              assert.isTrue(
                (yield* market.conditions).relayOnline,
                `the token's callback yielded at operation ${at}`
              )
            }),
        })
        assert.isAbove(operations, 0)
      }),
    60_000
  )
})

describe("the relay going offline", () => {
  it.effect(
    "a ready relay socket that already closed doesn't keep the relay online",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Stockbit")
        const other = yield* market.relayAccepted
        yield* market.tokenOn(other)
        // Closed, its own close not handled yet.
        other.isOpen = false
        yield* market.relayClosed
        yield* TestClock.adjust("250 millis")
        assert.isFalse((yield* market.conditions).relayOnline)
      })
  )

  it.effect(
    "the closing relay socket, still listed open and ready, isn't counted as remaining",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Stockbit")
        yield* market.relayClosed
        yield* TestClock.adjust("250 millis")
        assert.isFalse((yield* market.conditions).relayOnline)
      })
  )
})

const gapsOf = (conditions: MarketConditions) =>
  conditions.gaps.map((gap) => ({
    from: DateTime.formatIso(gap.from),
    to: gap.to === undefined ? undefined : DateTime.formatIso(gap.to),
  }))

describe("feed freshness", () => {
  it.effect(
    "live on the first frame, stale after 15 s of silence, unavailable after 60 s",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        assert.deepStrictEqual(yield* market.feeds, {
          Stockbit: "unavailable",
          Ajaib: "unavailable",
        })
        yield* market.frames("Ajaib")
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* market.feeds).Ajaib, "live")
        yield* TestClock.adjust("13 seconds")
        assert.strictEqual((yield* market.feeds).Ajaib, "live")
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual((yield* market.feeds).Ajaib, "stale")
        yield* TestClock.adjust("45 seconds")
        assert.strictEqual((yield* market.feeds).Ajaib, "unavailable")
        // Back with no settling delay.
        yield* market.frames("Ajaib", "B")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual((yield* market.feeds).Ajaib, "live")
      })
  )

  it.effect("a ping reply is a sign of life", () =>
    Effect.gen(function* () {
      const market = yield* marketAt("2026-11-09T10:00:00")
      yield* market.frames("Stockbit")
      for (let i = 0; i < 4; i++) {
        yield* TestClock.adjust("10 seconds")
        yield* market.reported("Stockbit", "A", "alive")
      }
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* market.feeds).Stockbit, "live")
    })
  )

  it.effect("silence through the break never goes stale", () =>
    Effect.gen(function* () {
      const market = yield* marketAt("2026-11-09T11:59:55")
      yield* market.frames("Stockbit")
      // 6 s of session 1, then the break.
      yield* TestClock.adjust("1 hour")
      assert.strictEqual((yield* market.feeds).Stockbit, "live")
      // 13:30:00 starts session 2: 9 more seconds make 15.
      yield* TestClock.setTime(
        DateTime.toEpochMillis(wib("2026-11-09T13:30:08"))
      )
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual((yield* market.feeds).Stockbit, "stale")
    })
  )

  it.effect("silence in pre-opening counts only from the 08:58 match", () =>
    Effect.gen(function* () {
      const opening = yield* marketAt("2026-11-10T08:46:00")
      yield* opening.frames("Ajaib")
      yield* TestClock.setTime(
        DateTime.toEpochMillis(wib("2026-11-10T08:58:10"))
      )
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual((yield* opening.feeds).Ajaib, "live")
      yield* TestClock.adjust("4 seconds")
      assert.strictEqual((yield* opening.feeds).Ajaib, "stale")
    })
  )

  it.effect(
    "a reported close makes a feed unavailable once its last connection closed",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Stockbit", "A")
        yield* market.frames("Stockbit", "B")
        yield* market.frames("Ajaib", "A")
        yield* market.reported("Stockbit", "A", "closed")
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* market.feeds, {
          Stockbit: "live",
          Ajaib: "live",
        })
        yield* market.reported("Stockbit", "B", "closed")
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* market.feeds, {
          Stockbit: "unavailable",
          Ajaib: "live",
        })
      })
  )

  it.effect(
    "Ajaib's on-demand frames are no sign of life once its trade sockets closed",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Ajaib", "A")
        yield* TestClock.adjust("10 seconds")
        yield* market.reported("Ajaib", "A", "closed")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual((yield* market.feeds).Ajaib, "unavailable")
        // The price, indicative and order book sockets still answer.
        yield* market.frames("Ajaib", "A", [], "on-demand")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual((yield* market.feeds).Ajaib, "unavailable")
        assert.deepStrictEqual(gapsOf(yield* market.conditions).at(-1), {
          from: "2026-11-09T03:00:10.000Z",
          to: undefined,
        })
        yield* market.frames("Ajaib", "A", [], "trade")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual((yield* market.feeds).Ajaib, "live")
      })
  )

  it.effect(
    "with no ingest socket, both feeds are unavailable: relay offline",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Stockbit")
        yield* market.frames("Ajaib")
        yield* TestClock.adjust("250 millis")
        assert.isTrue((yield* market.conditions).relayOnline)
        yield* market.relayClosed
        yield* TestClock.adjust("250 millis")
        const conditions = yield* market.conditions
        assert.isFalse(conditions.relayOnline)
        assert.deepStrictEqual(conditions.feeds, {
          Stockbit: "unavailable",
          Ajaib: "unavailable",
        })
      })
  )
})

// 08:58 to 08:59 and 09:00 to 10:00 WIB, before a relay connected at 10:00.
const MORNING = [
  { from: "2026-11-09T01:58:00.000Z", to: "2026-11-09T01:59:00.000Z" },
  { from: "2026-11-09T02:00:00.000Z", to: "2026-11-09T03:00:00.000Z" },
]

describe("relay gaps", () => {
  it.effect(
    "a stretch where both feeds were down is a gap; one feed down is not",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T10:00:00")
        yield* market.frames("Stockbit")
        yield* market.frames("Ajaib")
        yield* TestClock.adjust("10 seconds")
        // Ajaib keeps going; Stockbit's silence is no gap.
        for (let i = 0; i < 3; i++) {
          yield* market.frames("Ajaib")
          yield* TestClock.adjust("10 seconds")
        }
        assert.strictEqual((yield* market.feeds).Stockbit, "stale")
        // The morning before the relay connected wasn't recorded.
        assert.deepStrictEqual(gapsOf(yield* market.conditions), MORNING)
        // Ajaib's last frame was at 10:00:30: stale from 10:00:45 until its
        // next, at 10:01:00.
        yield* TestClock.adjust("20 seconds")
        assert.deepStrictEqual(gapsOf(yield* market.conditions), [
          ...MORNING,
          { from: "2026-11-09T03:00:45.000Z", to: undefined },
        ])
        yield* market.frames("Ajaib")
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(gapsOf(yield* market.conditions), [
          ...MORNING,
          { from: "2026-11-09T03:00:45.000Z", to: "2026-11-09T03:01:00.000Z" },
        ])
      })
  )

  it.effect(
    "the relay offline in a stretch that expects trades is a gap, the break is not",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T11:59:00")
        yield* market.frames("Stockbit")
        yield* market.relayClosed
        yield* TestClock.setTime(
          DateTime.toEpochMillis(wib("2026-11-09T13:30:30"))
        )
        yield* TestClock.adjust("1 second")
        // Ajaib never delivered, so from the 08:58 match on; the break
        // between is no gap.
        assert.deepStrictEqual(gapsOf(yield* market.conditions), [
          { from: "2026-11-09T01:58:00.000Z", to: "2026-11-09T01:59:00.000Z" },
          { from: "2026-11-09T02:00:00.000Z", to: "2026-11-09T05:00:01.000Z" },
          { from: "2026-11-09T06:30:00.000Z", to: undefined },
        ])
      })
  )
})

describe("market phase", () => {
  it.effect("names the phase, with no next open while the market is open", () =>
    Effect.gen(function* () {
      const open = yield* marketAt("2026-11-09T10:00:00")
      const during = yield* open.conditions
      assert.strictEqual(during.phase, "session-1")
      assert.isUndefined(during.nextOpen)
    })
  )

  it.effect("on a weekend, closed until Monday's 08:45 WIB", () =>
    Effect.gen(function* () {
      const weekend = yield* marketAt("2026-11-14T10:00:00")
      const shut = yield* weekend.conditions
      assert.strictEqual(shut.phase, "closed")
      assert.strictEqual(
        DateTime.formatIso(shut.nextOpen!),
        "2026-11-16T01:45:00.000Z"
      )
    })
  )

  it.effect("a phase change reaches viewers without a frame", () =>
    Effect.gen(function* () {
      const market = yield* marketAt("2026-11-09T11:59:58")
      assert.strictEqual((yield* market.conditions).phase, "session-1")
      yield* TestClock.adjust("4 seconds")
      assert.strictEqual((yield* market.conditions).phase, "break")
    })
  )
})

// Stockbit `iepiev` (wrapper case 11) for one code, by the field numbers of
// `securities.transactional.datafeed.v1`; the sample is the 2026-11-09 probe's.
const iepiev = (code: string, price: number, volume: number, at: string) => {
  const varint = (value: number) => {
    const bytes: Array<number> = []
    let rest = value
    while (rest >= 0x80) {
      bytes.push((rest % 0x80) | 0x80)
      rest = Math.floor(rest / 0x80)
    }
    return [...bytes, rest]
  }
  const text = (field: number, value: string) => {
    const bytes = [...new TextEncoder().encode(value)]
    return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]
  }
  const double = (field: number, value: number) => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    return [...varint(field * 8 + 1), ...bytes]
  }
  const body = [
    ...text(1, code),
    ...double(2, price),
    ...double(3, volume),
    ...text(5, at),
  ]
  return Uint8Array.from([
    ...varint(11 * 8 + 2),
    ...varint(body.length),
    ...body,
  ])
}

// Ajaib `INDICATIVE`, as the 2026-11-09 probe saw it.
const ajaibIndicative = (price: number, volume: number, updateTime: number) =>
  JSON.stringify({
    ticker: "BBCA",
    updateTime,
    openQty: volume,
    openPrice: price,
    bestBid: 5325,
    bestOffer: 5325,
    crossType: "K",
  })

describe("indicative price", () => {
  it.effect(
    "Stockbit's while it is live, Ajaib's when it isn't, in the snapshot and in deltas",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T15:50:01")
        const at = Date.parse("2026-11-09T15:50:01+07:00")
        yield* market.frames("Stockbit", "A", [
          iepiev("BBCA", 5325, 1500, "2026-11-09T15:50:01.03944+07:00"),
        ])
        yield* market.frames("Ajaib", "A", [ajaibIndicative(5300, 1000, at)])
        yield* TestClock.adjust("250 millis")
        const indicativeOf = Effect.gen(function* () {
          let price: number | undefined
          for (const message of yield* market.page.received) {
            const prices =
              message._tag === "Snapshot"
                ? (message.indicative ?? [])
                : (message.indicative ?? [])
            for (const each of prices)
              if (each.code === BBCA) price = each.price
          }
          return price
        })
        assert.strictEqual(yield* indicativeOf, 5325)
        yield* market.reported("Stockbit", "A", "closed")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual(yield* indicativeOf, 5300)
      })
  )

  it.effect(
    "a frame not newer than the price held, as the other connection delivers one late, changes nothing",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T15:50:01")
        const newest = iepiev(
          "BBCA",
          5325,
          1500,
          "2026-11-09T15:50:01.03944+07:00"
        )
        yield* market.frames("Stockbit", "A", [newest])
        yield* TestClock.adjust("250 millis")
        // Connection B: the frame before A's, then A's own again.
        yield* market.frames("Stockbit", "B", [
          iepiev("BBCA", 5300, 1000, "2026-11-09T15:50:00.9+07:00"),
        ])
        yield* TestClock.adjust("250 millis")
        yield* market.frames("Stockbit", "B", [newest])
        yield* TestClock.adjust("250 millis")
        // Ajaib, standing in once Stockbit is lost: the same late delivery.
        yield* market.reported("Stockbit", "A", "closed")
        yield* market.reported("Stockbit", "B", "closed")
        const at = Date.parse("2026-11-09T15:50:02+07:00")
        yield* market.frames("Ajaib", "A", [ajaibIndicative(5350, 2000, at)])
        yield* TestClock.adjust("250 millis")
        yield* market.frames("Ajaib", "B", [
          ajaibIndicative(5340, 1900, at - 500),
        ])
        yield* TestClock.adjust("250 millis")
        const sent = (yield* market.page.received)
          .flatMap((message) => message.indicative ?? [])
          .filter((price) => price.code === BBCA)
          .map(({ price, volume }) => [price, volume])
        assert.deepStrictEqual(sent, [
          [5325, 1500],
          [5350, 2000],
        ])
      })
  )

  it.effect(
    "an indicative frame from another trading day, a broker's cached one, is dropped",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-10T08:50:01")
        yield* market.frames("Stockbit", "A", [
          iepiev("BBCA", 5325, 1500, "2026-11-09T15:50:01.03944+07:00"),
        ])
        yield* market.reported("Stockbit", "A", "closed")
        yield* market.frames("Ajaib", "A", [
          ajaibIndicative(5300, 1000, Date.parse("2026-11-09T15:50:01+07:00")),
        ])
        yield* TestClock.adjust("250 millis")
        const sent = Effect.map(market.page.received, (messages) =>
          messages
            .flatMap((message) => message.indicative ?? [])
            .filter((price) => price.code === BBCA)
            .map(({ price, volume }) => [price, volume])
        )
        assert.deepStrictEqual(yield* sent, [])
        yield* market.frames("Ajaib", "A", [
          ajaibIndicative(5310, 1100, Date.parse("2026-11-10T08:50:01+07:00")),
        ])
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* sent, [[5310, 1100]])
      })
  )

  it.effect(
    "an indicative price from pre-opening is not served once pre-closing runs: only one whose time is in the auction running now",
    () =>
      Effect.gen(function* () {
        // Session 2's last second, with the morning's price still held.
        const market = yield* marketAt("2026-11-09T15:49:59")
        yield* market.frames("Stockbit", "A", [
          iepiev("BBCA", 5325, 1500, "2026-11-09T08:50:01.03944+07:00"),
        ])
        yield* TestClock.adjust("2 seconds")
        const sent = Effect.map(market.page.received, (messages) =>
          messages
            .flatMap((message) => message.indicative ?? [])
            .filter((price) => price.code === BBCA)
            .map(({ price, volume }) => [price, volume])
        )
        assert.deepStrictEqual(yield* sent, [])
        // 15:50:01, pre-closing: a fresh selection's snapshot carries none.
        yield* market.select(BBCA)
        const snapshot = (yield* market.page.received)
          .filter((message) => message._tag === "Snapshot")
          .at(-1)
        assert.isUndefined(snapshot?.indicative)
        // The closing auction's own frame is served.
        yield* market.frames("Stockbit", "A", [
          iepiev("BBCA", 5400, 2000, "2026-11-09T15:50:01.5+07:00"),
        ])
        yield* TestClock.adjust("250 millis")
        assert.deepStrictEqual(yield* sent, [[5400, 2000]])
      })
  )

  it.effect(
    "a snapshot carries the selected and watchlist codes' indicative prices",
    () =>
      Effect.gen(function* () {
        const market = yield* marketAt("2026-11-09T15:50:01")
        yield* market.frames("Stockbit", "A", [
          iepiev("BBCA", 5325, 1500, "2026-11-09T15:50:01.03944+07:00"),
          iepiev("BBRI", 4010, 900, "2026-11-09T15:50:01.04+07:00"),
          iepiev("TLKM", 2990, 100, "2026-11-09T15:50:01.05+07:00"),
        ])
        yield* market.select(BBCA, [StockCode.make("BBRI")])
        const snapshot = (yield* market.page.received)
          .filter((message) => message._tag === "Snapshot")
          .at(-1)
        assert.deepStrictEqual(
          snapshot?.indicative?.map(({ code, price }) => [code, price]),
          [
            ["BBCA", 5325],
            ["BBRI", 4010],
          ]
        )
      })
  )
})
