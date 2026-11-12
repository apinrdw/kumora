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
  decodeIngestUp,
  decodeViewerDown,
  decodeViewerUp,
  encodeIngestDown,
  encodeIngestUp,
  encodeViewerDown,
  encodeViewerUp,
} from "@workspace/relay"
import type {
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
    "a delta's running trades and candles round trip with their time",
    () =>
      Effect.gen(function* () {
        const message: ViewerDown = {
          _tag: "Delta",
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
              frequency: 82,
            },
          ],
        }
        const wire = yield* encodeViewerDown(message)
        assert.deepStrictEqual(yield* decodeViewerDown(wire), message)
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
