import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import {
  BROKER_CODES_BATCH_LIMIT,
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  ajaibRowCodes,
  brokerCodesDay,
  brokerCodesPath,
  decodeBrokerCodesBatch,
  decodeBrokerCodesStatus,
  encodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  stockbitRowCodes,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type TradeCodes,
} from "@workspace/relay"

const DAY = WibDate.make("2026-11-12")
const number = (value: string) => TradeNumber.make(value)
const codes: TradeCodes = {
  buyer: BrokerCode.make("YP"),
  buyerType: "D",
  seller: BrokerCode.make("CC"),
  sellerType: "F",
}

describe("a broker codes batch", () => {
  it.effect("rows and end travel and come back equal", () =>
    Effect.gen(function* () {
      const batch: BrokerCodesBatch = {
        version: BrokerCodesProtocolVersion,
        feed: "Ajaib",
        day: DAY,
        rows: [
          [number("1"), codes],
          [number("1500490"), codes],
        ],
        end: { n: number("1500490") },
      }
      const wire = yield* encodeBrokerCodesBatch(batch)
      assert.deepStrictEqual(yield* decodeBrokerCodesBatch(wire), batch)
    })
  )

  it.effect("may be an end alone", () =>
    Effect.gen(function* () {
      const batch: BrokerCodesBatch = {
        version: BrokerCodesProtocolVersion,
        feed: "Stockbit",
        day: DAY,
        rows: [],
        end: { n: number("1102785") },
      }
      const wire = yield* encodeBrokerCodesBatch(batch)
      assert.deepStrictEqual(yield* decodeBrokerCodesBatch(wire), batch)
    })
  )

  it.effect(
    "of another version fails as a version mismatch before its shape is read",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decodeBrokerCodesBatch('{"version":2,"rows":"not rows"}')
        )
        assert.strictEqual(error._tag, "BrokerCodesVersionMismatch")
      })
  )

  it.effect(
    "of the most rows, at the longest trade numbers, fits the body limit, and one row more fails",
    () =>
      Effect.gen(function* () {
        const full: BrokerCodesBatch = {
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day: DAY,
          rows: Array.from({ length: 5_000 }, (_, at) => [
            number(String(9_999_995_000 + at)),
            codes,
          ]),
          end: { n: number("9999999999") },
        }
        const wire = yield* encodeBrokerCodesBatch(full)
        assert.isBelow(wire.length, BROKER_CODES_BATCH_LIMIT)
        const over = yield* Effect.flip(
          encodeBrokerCodesBatch({
            ...full,
            rows: [...full.rows, [number("1"), codes]],
          })
        )
        assert.strictEqual(over._tag, "SchemaError")
      })
  )

  it.effect(
    "with a malformed row, or a trade number outside a day's, fails to decode",
    () =>
      Effect.gen(function* () {
        for (const row of [
          ["1", { ...codes, buyer: "yp" }],
          ["0", codes],
          ["12345678901", codes],
        ]) {
          const error = yield* Effect.flip(
            decodeBrokerCodesBatch(
              JSON.stringify({
                version: BrokerCodesProtocolVersion,
                feed: "Ajaib",
                day: DAY,
                rows: [row],
              })
            )
          )
          assert.strictEqual(error._tag, "SchemaError", JSON.stringify(row))
        }
      })
  )
})

describe("a broker codes status", () => {
  const statuses: ReadonlyArray<BrokerCodesStatus> = [
    {
      version: BrokerCodesProtocolVersion,
      day: DAY,
      n: null,
      complete: false,
      missing: [[number("1"), number("20")]],
      sources: { ajaib: 0, stockbit: 0 },
      crossCheck: { state: "none" },
    },
    {
      version: BrokerCodesProtocolVersion,
      day: DAY,
      n: number("1500490"),
      complete: false,
      missing: [[number("7"), number("9")]],
      sources: { ajaib: 1_500_487, stockbit: 0 },
      crossCheck: { state: "pending", walkedTo: number("0") },
    },
    {
      version: BrokerCodesProtocolVersion,
      day: DAY,
      n: number("1500490"),
      complete: true,
      missing: [],
      sources: { ajaib: 1_500_487, stockbit: 3 },
      crossCheck: { state: "compared", covered: 1_500_487, differences: 4 },
    },
  ]
  for (const status of statuses)
    it.effect(
      `round trips with its cross-check ${status.crossCheck.state}`,
      () =>
        Effect.gen(function* () {
          const wire = yield* encodeBrokerCodesStatus(status)
          assert.deepStrictEqual(yield* decodeBrokerCodesStatus(wire), status)
        })
    )
})

describe("the broker codes path", () => {
  it.effect("names the day", () =>
    Effect.gen(function* () {
      const path = yield* brokerCodesPath(DAY)
      assert.strictEqual(path, "/api/broker-codes/2026-11-12")
      assert.deepStrictEqual(
        yield* brokerCodesDay(path),
        Option.some(Option.some(DAY))
      )
    })
  )

  it.effect("under the prefix with a bad date reads as no day", () =>
    Effect.gen(function* () {
      for (const path of [
        "/api/broker-codes/2026-13-01",
        "/api/broker-codes/2026-11-12/extra",
        "/api/broker-codes/",
        "/api/broker-codes",
      ])
        assert.deepStrictEqual(
          yield* brokerCodesDay(path),
          Option.some(Option.none()),
          path
        )
    })
  )

  it.effect("elsewhere is not a broker codes path", () =>
    Effect.gen(function* () {
      for (const path of ["/api/auth/session", "/api/broker-codesx/2026-11-12"])
        assert.isTrue(Option.isNone(yield* brokerCodesDay(path)), path)
    })
  )
})

describe("an Ajaib row", () => {
  const row = {
    trade_num: "202611120001500490",
    buyer: "YP",
    buyer_type: "D",
    seller: "CC",
    seller_type: "F",
  }

  it.effect("with both codes and both types gives the trade's codes", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* ajaibRowCodes(row), Option.some(codes))
    })
  )

  it.effect("empty, malformed, or with another investor type is missing", () =>
    Effect.gen(function* () {
      for (const bad of [
        { ...row, buyer: "" },
        { ...row, seller: "C" },
        { ...row, buyer: "yp" },
        { ...row, seller: 12 },
        { ...row, buyer_type: "LOCAL-BROKER" },
        { ...row, seller_type: "" },
        { trade_num: row.trade_num },
        "not a row",
        null,
      ])
        assert.isTrue(
          Option.isNone(yield* ajaibRowCodes(bad)),
          JSON.stringify(bad)
        )
    })
  )
})

describe("a Stockbit row", () => {
  const row = {
    trade_number: "1500490",
    is_broker_exists: true,
    buyer: "YP [D]",
    seller: " CC [F] ",
    buyer_type: "BROKER_TYPE_UNSPECIFIED",
    seller_type: "BROKER_TYPE_UNSPECIFIED",
  }

  it.effect("with both tagged codes gives the trade's codes", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* stockbitRowCodes(row), Option.some(codes))
    })
  )

  it.effect("empty, untagged, malformed or without brokers is missing", () =>
    Effect.gen(function* () {
      for (const bad of [
        { ...row, is_broker_exists: false },
        { ...row, buyer: "", seller: "" },
        { ...row, buyer: "YP" },
        { ...row, seller: "CC [X]" },
        { ...row, buyer: "Y [D]" },
        { ...row, seller: null },
        { trade_number: "1" },
        [],
      ])
        assert.isTrue(
          Option.isNone(yield* stockbitRowCodes(bad)),
          JSON.stringify(bad)
        )
    })
  )
})
