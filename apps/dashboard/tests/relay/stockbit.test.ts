import { describe, expect, test } from "vitest"

import { decodeWrap, unpackCoalesced } from "@/relay/stockbit"

import {
  capturedFrames,
  wireBatch,
  wireBatchWithRawTrade,
  wireLivePrice,
} from "../support/stockbit-wire"
import { readCapture } from "../support/whale-capture"

const T = "2026-10-29T03:00:00Z"

describe("decodeWrap", () => {
  test("reads every field of a trade by number", () => {
    const frame = decodeWrap(
      wireBatch([
        {
          stock: "BBCA",
          price: 9000,
          volume: 500,
          action: 2,
          time: T,
          change: -25,
          tradeNumber: 41,
          board: 3,
          value: 4_500_000,
        },
      ])
    )
    expect(frame).toEqual({
      channel: "running_trade_batch",
      undecodable: 0,
      trades: [
        {
          stock: "BBCA",
          price: 9000,
          volume: 500,
          action: 2,
          time: "2026-10-29T03:00:00.000Z",
          change: -25,
          tradeNumber: 41,
          board: 3,
          value: 4_500_000,
        },
      ],
    })
  })

  test("reads a change absent on the wire as 0", () => {
    const frame = decodeWrap(
      wireBatch([{ stock: "BBCA", time: T, tradeNumber: 1 }])
    )
    expect(frame).toMatchObject({ trades: [{ change: 0 }] })
  })

  test("decodes the capture's tape frames, with BBCA's numbers rising", () => {
    let batches = 0
    const numbers: Array<number> = []
    for (const bytes of capturedFrames()) {
      const frame = decodeWrap(bytes)
      expect(frame.channel).not.toBe("malformed")
      if (frame.channel !== "running_trade_batch") continue
      batches++
      expect(frame.undecodable).toBe(0)
      for (const t of frame.trades)
        if (t.stock === "BBCA") numbers.push(t.tradeNumber)
    }
    expect(batches).toBeGreaterThan(1000)
    expect(numbers.length).toBeGreaterThan(0)
    expect(numbers.every((n) => Number.isInteger(n) && n > 0)).toBe(true)
  })

  test("skips and counts a broken trade, keeping those around it", () => {
    // Field 3 is a double, cut to two bytes.
    const broken = [0x19, 0x01, 0x02]
    const frame = decodeWrap(
      wireBatchWithRawTrade(
        { stock: "BBCA", time: T, tradeNumber: 1 },
        broken,
        { stock: "BBRI", time: T, tradeNumber: 2 }
      )
    )
    expect(frame).toMatchObject({
      channel: "running_trade_batch",
      undecodable: 1,
      trades: [{ stock: "BBCA" }, { stock: "BBRI" }],
    })
  })

  test("names a frame it cannot walk, without throwing", () => {
    // Field 8, length-delimited, with a truncated length varint.
    expect(decodeWrap(new Uint8Array([0x42, 0x80]))).toEqual({
      channel: "malformed",
    })
  })

  test("tells ping and other channels from the tape", () => {
    expect(decodeWrap(new Uint8Array([0x12, 0x00]))).toEqual({
      channel: "ping",
    })
    expect(decodeWrap(new Uint8Array([0x52, 0x00]))).toEqual({
      channel: "other",
      field: 10,
    })
  })

  test("a liveprice frame with no stock code is malformed", () => {
    expect(decodeWrap(new Uint8Array([0x4a, 0x00]))).toEqual({
      channel: "malformed",
    })
  })
})

describe("unpackCoalesced", () => {
  const message = (...frames: ReadonlyArray<ReadonlyArray<number>>) =>
    new Uint8Array([0x00, ...frames.flatMap((f) => [f.length, 0, 0, 0, ...f])])

  test("returns each length-prefixed frame in order", () => {
    expect(unpackCoalesced(message([0x4a, 0x00], [0x4a]))).toEqual({
      frames: [new Uint8Array([0x4a, 0x00]), new Uint8Array([0x4a])],
      truncated: false,
    })
  })

  test("keeps the whole frames before a truncated one", () => {
    const cut = message([0x4a, 0x00], [0x4a, 0x01, 0x02]).slice(0, -1)
    expect(unpackCoalesced(cut)).toEqual({
      frames: [new Uint8Array([0x4a, 0x00])],
      truncated: true,
    })
  })

  test("reads a length cut short as truncated, not as a throw", () => {
    expect(unpackCoalesced(new Uint8Array([0x00, 0x01]))).toEqual({
      frames: [],
      truncated: true,
    })
  })
})

describe("a liveprice frame's match", () => {
  const ORDER = "202610290002329192"
  const MATCH = "202610290000805178"

  test("order and match numbers above 2^53 keep every digit", () => {
    expect(Number(ORDER) > Number.MAX_SAFE_INTEGER).toBe(true)
    const frame = decodeWrap(
      wireLivePrice({
        stock: "BBCA",
        date: "2026-10-29T13:31:00.000",
        volume: 100,
        lastprice: 5050,
        verb: "S",
        quantity: 4000,
        orderNumber: ORDER,
        matchNumber: MATCH,
      })
    )
    expect(frame).toMatchObject({
      channel: "liveprice",
      liveprice: {
        lastprice: 5050,
        verb: "S",
        quantity: 4000,
        orderNumber: ORDER,
        matchNumber: MATCH,
      },
    })
  })

  test("a frame without them reads as nulls", () => {
    const frame = decodeWrap(
      wireLivePrice({
        stock: "BBCA",
        date: "2026-10-29T13:31:00.000",
        volume: 1,
      })
    )
    expect(frame).toMatchObject({
      liveprice: {
        lastprice: null,
        verb: null,
        quantity: null,
        orderNumber: null,
        matchNumber: null,
      },
    })
  })

  test("the capture's frames decode to the fixture's rows", () => {
    const { liveprice } = readCapture()
    const decoded = capturedFrames().flatMap((bytes) => {
      const frame = decodeWrap(bytes)
      if (frame.channel !== "liveprice") return []
      const p = frame.liveprice
      return [
        [
          p.stock,
          p.lastprice,
          p.quantity,
          p.verb,
          p.orderNumber,
          p.matchNumber,
        ],
      ]
    })
    expect(decoded).toEqual(liveprice.map((row) => row.slice(1)))
  })
})
