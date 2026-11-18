import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import {
  IngestCloseCode,
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  TradeNumberOrder,
  VIEWER_MESSAGE_LIMIT,
  ViewerCloseCode,
  ViewerProtocolVersion,
  decodeIngestDown,
  decodeRecordedBookEvents,
  decodeIngestUp,
  decodeViewerDown,
  decodeViewerUp,
  encodeIngestDown,
  encodeRecordedBookEvents,
  encodeIngestUp,
  encodeViewerDown,
  encodeViewerUp,
} from "@workspace/relay"
import type {
  BookEvent,
  BookReadings,
  IngestDown,
  IngestUp,
  ViewerDown,
  ViewerUp,
} from "@workspace/relay"

const receivedAt = DateTime.makeUnsafe("2026-11-09T02:00:00.250Z")

const roundTrip = Effect.fnUntraced(function* (message: IngestUp) {
  const wire = yield* encodeIngestUp(message)
  assert.isString(wire)
  return yield* decodeIngestUp(wire)
})

describe("ingest envelope, up", () => {
  it.effect("Stockbit frames travel as bytes and come back equal", () =>
    Effect.gen(function* () {
      const frame = new Uint8Array([0x0a, 0x04, 0x42, 0x42, 0x43, 0x41, 0xff])
      const message: IngestUp = {
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt,
        frames: [frame],
      }
      assert.deepStrictEqual(yield* roundTrip(message), message)
    })
  )

  it.effect("Ajaib frames travel as their JSON text, unparsed", () =>
    Effect.gen(function* () {
      const text = '{"event":"PRICE","data":{"s":"BBCA","tn":2026110900012345}}'
      const message: IngestUp = {
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        stream: "trade",
        connection: "B",
        receivedAt,
        frames: [text],
      }
      assert.deepStrictEqual(yield* roundTrip(message), message)
    })
  )

  it.effect("the token, code list and feed status round trip", () =>
    Effect.gen(function* () {
      const messages: ReadonlyArray<IngestUp> = [
        { _tag: "Token", protocolVersion: IngestProtocolVersion, token: "t" },
        {
          _tag: "CodeList",
          protocolVersion: IngestProtocolVersion,
          receivedAt,
          body: '{"data":[{"code":"BBCA"}]}',
        },
        {
          _tag: "FeedStatus",
          protocolVersion: IngestProtocolVersion,
          feed: "Stockbit",
          connection: "B",
          at: receivedAt,
          status: "closed",
        },
      ]
      for (const message of messages) {
        assert.deepStrictEqual(yield* roundTrip(message), message)
      }
    })
  )

  it.effect("an Ajaib envelope with byte frames is rejected", () =>
    Effect.gen(function* () {
      const wire = JSON.stringify({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        stream: "trade",
        connection: "A",
        receivedAt: 0,
        frames: [42],
      })
      const error = yield* Effect.flip(decodeIngestUp(wire))
      assert.strictEqual(error._tag, "SchemaError")
    })
  )

  it.effect("the previous version is accepted, any other is a mismatch", () =>
    Effect.gen(function* () {
      const withVersion = (protocolVersion: number) =>
        JSON.stringify({ _tag: "Token", protocolVersion, token: "t" })
      const previous = yield* decodeIngestUp(
        withVersion(IngestProtocolVersion - 1)
      )
      assert.strictEqual(previous.protocolVersion, IngestProtocolVersion - 1)
      for (const version of [
        IngestProtocolVersion + 1,
        IngestProtocolVersion - 2,
      ]) {
        const error = yield* Effect.flip(decodeIngestUp(withVersion(version)))
        assert.strictEqual(error._tag, "ProtocolVersionMismatch")
        assert.strictEqual(
          error._tag === "ProtocolVersionMismatch" && error.closeCode,
          IngestCloseCode.VersionMismatch
        )
      }
      // A message with no version at all is a mismatch too.
      const missing = yield* Effect.flip(
        decodeIngestUp(JSON.stringify({ _tag: "Token", token: "t" }))
      )
      assert.strictEqual(missing._tag, "ProtocolVersionMismatch")
    })
  )
})

describe("ingest envelope, down", () => {
  it.effect("a backfill request keeps trade numbers beyond 2^53 exact", () =>
    Effect.gen(function* () {
      // 2^53 is 9007199254740992; this is larger and odd.
      const from = TradeNumber.make("202611090000012345")
      const message: IngestDown = {
        _tag: "Backfill",
        from,
        to: TradeNumber.make("202611090000012399"),
        nextTime: DateTime.makeUnsafe("2026-11-09T02:00:05.250Z"),
      }
      const wire = yield* encodeIngestDown(message)
      assert.include(wire, '"202611090000012345"')
      assert.deepStrictEqual(yield* decodeIngestDown(wire), message)
    })
  )

  it.effect("on-demand codes round trip", () =>
    Effect.gen(function* () {
      const message: IngestDown = {
        _tag: "OnDemandCodes",
        codes: [StockCode.make("BBCA"), StockCode.make("TLKM")],
      }
      const wire = yield* encodeIngestDown(message)
      assert.deepStrictEqual(yield* decodeIngestDown(wire), message)
    })
  )

  it.effect("a trade number sent as a JSON number is rejected", () =>
    Effect.gen(function* () {
      const wire = '{"_tag":"Backfill","from":1,"to":2,"nextTime":0}'
      const error = yield* Effect.flip(decodeIngestDown(wire))
      assert.strictEqual(error._tag, "SchemaError")
    })
  )
})

describe("viewer protocol", () => {
  it.effect("the selection round trips at the current version", () =>
    Effect.gen(function* () {
      const message: ViewerUp = {
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make("BBCA"),
        watchlist: [StockCode.make("BBRI"), StockCode.make("TLKM")],
      }
      const wire = yield* encodeViewerUp(message)
      assert.deepStrictEqual(yield* decodeViewerUp(wire), message)
    })
  )

  it.effect(
    "a watchlist of 10,000 codes is accepted, one past that refused",
    () =>
      Effect.gen(function* () {
        const select = (codes: number) =>
          JSON.stringify({
            _tag: "Select",
            protocolVersion: ViewerProtocolVersion,
            selected: "BBCA",
            watchlist: Array.from({ length: codes }, (_, index) => `W${index}`),
          })
        assert.lengthOf(
          (yield* decodeViewerUp(select(10_000))).watchlist,
          10_000
        )
        const error = yield* Effect.flip(decodeViewerUp(select(10_001)))
        assert.strictEqual(error._tag, "SchemaError")
      })
  )

  it.effect(
    "a code past 16 characters is refused, and the largest Select accepted fits the message limit and stores under 200 KB",
    () =>
      Effect.gen(function* () {
        const select = (codes: ReadonlyArray<string>) =>
          JSON.stringify({
            _tag: "Select",
            protocolVersion: ViewerProtocolVersion,
            selected: codes[0],
            watchlist: codes,
          })
        const longest = Array.from(
          { length: 10_000 },
          (_, index) => `TN.W${String(index).padStart(12, "0")}`
        )
        assert.lengthOf(longest[0]!, 16)
        const message = yield* decodeViewerUp(select(longest))
        const { watchlist } = message
        assert.lengthOf(watchlist, 10_000)
        // As the socket carries it: the object reads a message only up to
        // the limit.
        const wire = yield* encodeViewerUp(message)
        assert.strictEqual(wire.length, 190_081)
        assert.isAtMost(wire.length, VIEWER_MESSAGE_LIMIT)
        // As the trading-day object stores a viewer's codes: one value, of
        // ASCII, so a character is a byte. Its storage holds 8 MB.
        assert.isBelow(JSON.stringify(watchlist).length, 200_000)
        const error = yield* Effect.flip(
          decodeViewerUp(select(["TN.W0000000000000"]))
        )
        assert.strictEqual(error._tag, "SchemaError")
      })
  )

  it.effect("only the current version is accepted", () =>
    Effect.gen(function* () {
      const wire = JSON.stringify({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion - 1,
        selected: "BBCA",
        watchlist: [],
      })
      const error = yield* Effect.flip(decodeViewerUp(wire))
      assert.strictEqual(error._tag, "ProtocolVersionMismatch")
      assert.strictEqual(
        error._tag === "ProtocolVersionMismatch" && error.closeCode,
        ViewerCloseCode.NewVersion
      )
      assert.strictEqual(ViewerCloseCode.SignInRequired, 4401)
    })
  )

  it.effect(
    "a page from before delayed freshness, on version 1, is told to reload",
    () =>
      Effect.gen(function* () {
        const wire = JSON.stringify({
          _tag: "Select",
          protocolVersion: 1,
          selected: "BBCA",
          watchlist: [],
        })
        const error = yield* Effect.flip(decodeViewerUp(wire))
        assert.strictEqual(
          error._tag === "ProtocolVersionMismatch" && error.closeCode,
          ViewerCloseCode.NewVersion
        )
      })
  )
})

describe("viewer protocol, down", () => {
  it.effect(
    "a delta's running trades and candles round trip with their time, and its own",
    () =>
      Effect.gen(function* () {
        const message: ViewerDown = {
          _tag: "Delta",
          at: DateTime.makeUnsafe("2026-11-09T07:15:00.250Z"),
          tape: [
            {
              tradeNumber: TradeNumber.make("2350"),
              time: DateTime.makeUnsafe("2026-11-09T01:58:00.000Z"),
              code: StockCode.make("SINI"),
              price: 7725,
              lots: 10,
              side: "none",
              board: "RG",
              feeds: ["Ajaib"],
            },
          ],
          candles: [
            {
              code: StockCode.make("IHSG"),
              minute: DateTime.makeUnsafe("2026-11-09T07:15:00.000Z"),
              open: 4975.55,
              high: 4979.874,
              low: 4975.55,
              close: 4979.874,
              volume: 3952,
              value: 285_634_400,
              buyValue: 0,
              sellValue: 0,
              frequency: 82,
            },
            {
              code: StockCode.make("SINI"),
              minute: DateTime.makeUnsafe("2026-11-09T01:58:00.000Z"),
              open: 7725,
              high: 7750,
              low: 7725,
              close: 7750,
              volume: 30,
              value: 23_225_000,
              buyValue: 15_500_000,
              sellValue: 0,
              frequency: 2,
            },
          ],
        }
        const wire = yield* encodeViewerDown(message)
        assert.deepStrictEqual(yield* decodeViewerDown(wire), message)
      })
  )

  it.effect("book readings round trip in a delta and a snapshot", () =>
    Effect.gen(function* () {
      assert.strictEqual(ViewerProtocolVersion, 6)
      const readings: BookReadings = {
        code: StockCode.make("ERAA"),
        at: DateTime.makeUnsafe("2026-11-18T03:00:00.125Z"),
        value: 5_000_000_000,
        imbalance: -0.2345,
        spread: { ticks: 2, percent: 0.995 },
        limit: "upper",
        bid: {
          depth: 14_815_000,
          lots: 150,
          emptyTicks: 2,
          widestGap: 1,
          lotsPerOrder: 6.25,
        },
        offer: {
          depth: 0,
          lots: 0,
          emptyTicks: 0,
          widestGap: 0,
          lotsPerOrder: undefined,
        },
      }
      const thin: BookReadings = {
        ...readings,
        code: StockCode.make("KOTA"),
        imbalance: undefined,
        spread: undefined,
        limit: undefined,
      }
      const delta: ViewerDown = {
        _tag: "Delta",
        at: DateTime.makeUnsafe("2026-11-18T03:00:00.250Z"),
        tape: [],
        candles: [],
        bookReadings: [readings, thin],
      }
      const deltaWire = yield* encodeViewerDown(delta)
      assert.deepStrictEqual(yield* decodeViewerDown(deltaWire), delta)
      // A reading travels as a short tuple, not keyed.
      assert.isBelow(
        JSON.stringify(JSON.parse(deltaWire).bookReadings[0]).length,
        110
      )
      const snapshot: ViewerDown = {
        _tag: "Snapshot",
        at: DateTime.makeUnsafe("2026-11-18T03:00:00.250Z"),
        selected: StockCode.make("ERAA"),
        tape: [],
        candles: [],
        footprints: [],
        conditions: {
          phase: "session-1",
          relayOnline: true,
          feeds: { Stockbit: "live", Ajaib: "live" },
          gaps: [],
        },
        bookReadings: [readings],
      }
      const snapshotWire = yield* encodeViewerDown(snapshot)
      assert.deepStrictEqual(yield* decodeViewerDown(snapshotWire), snapshot)
    })
  )

  it.effect("book events round trip in a delta, a snapshot and a GET", () =>
    Effect.gen(function* () {
      const code = StockCode.make("BBNI")
      const at = DateTime.makeUnsafe("2026-11-17T07:02:33.080Z")
      const events: ReadonlyArray<BookEvent> = [
        {
          kind: "absorbed",
          code,
          at,
          side: "offer",
          price: 110,
          lots: 19_994,
          orders: 40,
          shown: 4_200,
        },
        {
          kind: "eaten",
          code,
          at,
          side: "bid",
          price: 67,
          lots: 79_264,
          orders: 222,
          share: 0.95,
        },
        {
          kind: "reloaded",
          code,
          at,
          side: "bid",
          price: 2220,
          lots: 1_896,
          orders: 3,
          refills: 4,
          crowd: true,
        },
        {
          kind: "appeared",
          code,
          at,
          side: "bid",
          price: 100,
          lots: 50_000,
          orders: 1,
          ticks: 6,
        },
        {
          kind: "pulled",
          code,
          at,
          side: "bid",
          price: 3610,
          lots: 33_789,
          orders: 77,
          ticks: 1,
          approached: false,
        },
        {
          kind: "moved",
          code,
          at,
          side: "bid",
          price: 3620,
          lots: 28_711,
          orders: 3,
          to: 3610,
        },
      ]
      const delta: ViewerDown = {
        _tag: "Delta",
        at,
        tape: [],
        candles: [],
        bookEvents: events,
      }
      assert.deepStrictEqual(
        yield* decodeViewerDown(yield* encodeViewerDown(delta)),
        delta
      )
      const snapshot: ViewerDown = {
        _tag: "Snapshot",
        at,
        selected: code,
        tape: [],
        candles: [],
        footprints: [],
        conditions: {
          phase: "session-2",
          relayOnline: true,
          feeds: { Stockbit: "live", Ajaib: "live" },
          gaps: [],
        },
        bookEvents: events.slice(0, 2),
        selectedBookEvents: events,
      }
      assert.deepStrictEqual(
        yield* decodeViewerDown(yield* encodeViewerDown(snapshot)),
        snapshot
      )
      const answer = { code, recorded: true, events }
      assert.deepStrictEqual(
        yield* decodeRecordedBookEvents(
          yield* encodeRecordedBookEvents(answer)
        ),
        answer
      )
    })
  )

  it.effect(
    "a snapshot's scanner figures round trip, an unknown one as none",
    () =>
      Effect.gen(function* () {
        const snapshot: ViewerDown = {
          _tag: "Snapshot",
          at: DateTime.makeUnsafe("2026-11-18T02:00:00.250Z"),
          selected: StockCode.make("IHSG"),
          tape: [],
          candles: [],
          footprints: [],
          conditions: {
            phase: "session-1",
            relayOnline: true,
            feeds: { Stockbit: "live", Ajaib: "live" },
            gaps: [],
          },
          scannerFigures: [
            {
              code: StockCode.make("BBCA"),
              last: 7_550,
              previousClose: 7_500,
              previousValue: 1_250_000_000_000,
            },
            {
              code: StockCode.make("KOTA"),
              last: undefined,
              previousClose: undefined,
              previousValue: undefined,
            },
          ],
        }
        const wire = yield* encodeViewerDown(snapshot)
        assert.deepStrictEqual(yield* decodeViewerDown(wire), snapshot)
        // Each code travels as a short tuple.
        assert.deepStrictEqual(JSON.parse(wire).scannerFigures[1], [
          "KOTA",
          null,
          null,
          null,
        ])
      })
  )
})

describe("trade number order", () => {
  it("orders by number, not by text", () => {
    const sorted = ["10", "9", "100"]
      .map((n) => TradeNumber.make(n))
      .sort(TradeNumberOrder)
    assert.deepStrictEqual(sorted, ["9", "10", "100"])
  })
})
