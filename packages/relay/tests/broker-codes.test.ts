import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"

import {
  BROKER_CODES_BATCH_LIMIT,
  BrokerCode,
  BrokerCodesProtocolVersion,
  MISSING_RANGES,
  TradeNumber,
  WibDate,
  StockCode,
  ajaibRowCodes,
  ajaibRowFields,
  brokerCodesAfter,
  brokerCodesDay,
  brokerCodesPath,
  brokerCodesStatusPath,
  decodeBrokerCodesBatch,
  decodeBrokerCodesStatus,
  decodeRecordedBrokerCodes,
  encodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  encodeRecordedBrokerCodes,
  stockbitRowCodes,
  stockbitRowFields,
  stockbitRowOrderNumbers,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type RecordedBrokerCodes,
  type TradeCodes,
  type TradeFields,
} from "@workspace/relay"

const DAY = WibDate.make("2026-11-12")
const number = (value: string) => TradeNumber.make(value)
const codes: TradeCodes = {
  buyer: BrokerCode.make("YP"),
  buyerType: "D",
  seller: BrokerCode.make("CC"),
  sellerType: "F",
}
// 14:59:58 WIB on DAY.
const fields: TradeFields = {
  time: DateTime.makeUnsafe("2026-11-12T07:59:58.000Z"),
  code: StockCode.make("BBCA"),
  price: 8_000,
  lots: 0.5,
  board: "NG",
  side: "sell",
}

describe("a broker codes batch", () => {
  it.effect(
    "rows, with or without fields, and end travel and come back equal",
    () =>
      Effect.gen(function* () {
        const batch: BrokerCodesBatch = {
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day: DAY,
          rows: [
            [number("1"), codes, fields],
            [number("2"), codes],
            [number("1500490"), codes, fields],
          ],
          end: { n: number("1500490") },
        }
        const wire = yield* encodeBrokerCodesBatch(batch)
        assert.deepStrictEqual(yield* decodeBrokerCodesBatch(wire), batch)
      })
  )

  it.effect(
    "rows with order numbers, with fields or with none, travel and come back equal",
    () =>
      Effect.gen(function* () {
        // HOPE's trades 8799 and 8800 on 2026-11-20, as Stockbit sent them.
        const batch: BrokerCodesBatch = {
          version: BrokerCodesProtocolVersion,
          feed: "Stockbit",
          day: DAY,
          rows: [
            [number("8799"), codes, fields, [276_574, 53_352]],
            [number("8800"), codes, null, [276_574, 125_666]],
            [number("8801"), codes, fields],
          ],
        }
        const wire = yield* encodeBrokerCodesBatch(batch)
        assert.deepStrictEqual(yield* decodeBrokerCodesBatch(wire), batch)
      })
  )

  it.effect(
    "of version 4, rows without order numbers, fails as a version mismatch",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decodeBrokerCodesBatch(
            JSON.stringify({
              version: 4,
              feed: "Stockbit",
              day: DAY,
              rows: [
                [
                  "1",
                  codes,
                  { ...fields, time: DateTime.toEpochMillis(fields.time) },
                ],
              ],
            })
          )
        )
        assert.strictEqual(error._tag, "BrokerCodesVersionMismatch")
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
          decodeBrokerCodesBatch('{"version":1,"rows":"not rows"}')
        )
        assert.strictEqual(error._tag, "BrokerCodesVersionMismatch")
      })
  )

  it.effect(
    "of version 2, rows of codes alone, fails as a version mismatch",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decodeBrokerCodesBatch(
            JSON.stringify({
              version: 2,
              feed: "Ajaib",
              day: DAY,
              rows: [["1", codes]],
            })
          )
        )
        assert.strictEqual(error._tag, "BrokerCodesVersionMismatch")
      })
  )

  it.effect(
    "of version 3, fields without time or side, fails as a version mismatch",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decodeBrokerCodesBatch(
            JSON.stringify({
              version: 3,
              feed: "Ajaib",
              day: DAY,
              rows: [
                [
                  "1",
                  codes,
                  { code: "BBCA", price: 9_000, lots: 10, board: "RG" },
                ],
              ],
            })
          )
        )
        assert.strictEqual(error._tag, "BrokerCodesVersionMismatch")
      })
  )

  it.effect(
    "of the most rows, at the longest trade numbers, codes, prices and lots, fits the body limit, and one row more fails",
    () =>
      Effect.gen(function* () {
        const longest: TradeFields = {
          // The latest instant a Date holds.
          time: DateTime.makeUnsafe(8.64e15),
          code: StockCode.make("TN.ABCDEFGHIJKLM"),
          price: Number.MAX_SAFE_INTEGER,
          lots: Number.MAX_VALUE,
          board: "NG",
          side: "none",
        }
        const full: BrokerCodesBatch = {
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day: DAY,
          rows: Array.from({ length: 5_000 }, (_, at) => [
            number(String(9_999_995_000 + at)),
            codes,
            longest,
            [4_294_967_295, 4_294_967_295],
          ]),
          end: { n: number("9999999999") },
        }
        const wire = yield* encodeBrokerCodesBatch(full)
        assert.isBelow(wire.length, BROKER_CODES_BATCH_LIMIT)
        const over = yield* Effect.flip(
          encodeBrokerCodesBatch({
            ...full,
            rows: [...full.rows, [number("1"), codes, fields]],
          })
        )
        assert.strictEqual(over._tag, "SchemaError")
      })
  )

  it.effect(
    "with a malformed row, malformed fields, or a trade number outside a day's, fails to decode",
    () =>
      Effect.gen(function* () {
        // The fields as a batch's JSON carries them.
        const wire = { ...fields, time: DateTime.toEpochMillis(fields.time) }
        for (const row of [
          ["1", { ...codes, buyer: "yp" }, wire],
          ["1"],
          ["1", codes, { ...wire, lots: -1 }],
          ["1", codes, { ...wire, side: "up" }],
          ["1", codes, { ...wire, time: undefined }],
          ["1", codes, { ...wire, time: "2026-11-12T07:59:58.000Z" }],
          ["1", codes, { ...wire, price: 8_000.5 }],
          ["1", codes, { ...wire, board: "XX" }],
          ["0", codes, wire],
          ["12345678901", codes, wire],
          ["1", codes, wire, [0, 53_352]],
          ["1", codes, wire, [276_574, -1]],
          ["1", codes, wire, [276_574.5, 53_352]],
          ["1", codes, wire, ["276574", "53352"]],
          ["1", codes, wire, [276_574]],
          ["1", codes, wire, [4_294_967_296, 53_352]],
          ["1", codes, wire, null],
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

describe("a recorded day's broker codes answer", () => {
  it.effect(
    "travels as trade number and codes pairs, and comes back equal",
    () =>
      Effect.gen(function* () {
        const answer: RecordedBrokerCodes = {
          codes: [
            [number("1"), codes],
            [number("1500490"), codes],
          ],
          complete: true,
        }
        const wire = yield* encodeRecordedBrokerCodes(answer)
        assert.strictEqual(
          wire,
          '{"codes":[["1",{"buyer":"YP","buyerType":"D","seller":"CC","sellerType":"F"}],["1500490",{"buyer":"YP","buyerType":"D","seller":"CC","sellerType":"F"}]],"complete":true}'
        )
        assert.deepStrictEqual(yield* decodeRecordedBrokerCodes(wire), answer)
      })
  )

  it.effect("may list no trades", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* decodeRecordedBrokerCodes('{"codes":[],"complete":false}'),
        { codes: [], complete: false }
      )
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
      missingCount: 20,
      sources: { ajaib: 0, stockbit: 0 },
      crossCheck: { state: "none" },
      orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
    },
    {
      version: BrokerCodesProtocolVersion,
      day: DAY,
      n: number("1500490"),
      complete: false,
      missing: [[number("7"), number("9")]],
      missingCount: 3,
      sources: { ajaib: 1_500_487, stockbit: 0 },
      crossCheck: { state: "pending", walkedTo: number("0") },
      orderNumbers: { ajaib: 1_500_000, stockbit: 0, differences: 0 },
    },
    {
      version: BrokerCodesProtocolVersion,
      day: DAY,
      n: number("1500490"),
      complete: true,
      missing: [],
      missingCount: 0,
      sources: { ajaib: 1_500_487, stockbit: 3 },
      crossCheck: { state: "compared", covered: 1_500_487, differences: 4 },
      orderNumbers: { ajaib: 1_499_000, stockbit: 1_490, differences: 2 },
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

  it.effect(`lists at most ${MISSING_RANGES} ranges`, () =>
    Effect.gen(function* () {
      const listing = (ranges: number) =>
        JSON.stringify({
          ...statuses[0],
          missing: Array.from({ length: ranges }, (_, at) => [
            String(2 * at + 2),
            String(2 * at + 2),
          ]),
          missingCount: 750_000,
        })
      yield* decodeBrokerCodesStatus(listing(MISSING_RANGES))
      const error = yield* Effect.flip(
        decodeBrokerCodesStatus(listing(MISSING_RANGES + 1))
      )
      assert.strictEqual(error._tag, "SchemaError")
    })
  )
})

// A query's one `after`, as URLSearchParams reads it; the package has no
// DOM types.
const query = (after: string | null) => ({
  get: (name: string) => (name === "after" ? after : null),
})

describe("a status GET's after", () => {
  it.effect("goes on the status path, and is 0 when absent", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* brokerCodesStatusPath(DAY, number("2000")),
        "/api/broker-codes/2026-11-12?after=2000"
      )
      assert.deepStrictEqual(
        yield* brokerCodesAfter(query("2000")),
        Option.some(2_000)
      )
      assert.deepStrictEqual(
        yield* brokerCodesAfter(query(null)),
        Option.some(0)
      )
    })
  )

  it.effect("is none when it isn't a trade number", () =>
    Effect.gen(function* () {
      for (const after of ["x", "-1", "1.5", "", "99999999999999999999"])
        assert.deepStrictEqual(
          yield* brokerCodesAfter(query(after)),
          Option.none(),
          after
        )
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
    stock_code: "BBCA",
    price: 8_000,
    lot: 0.5,
    market_type: "NG",
    side: "SELL",
    timestamp: 1_794_470_398_000,
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
  it.effect("gives the trade's fields, its time from its epoch ms", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* ajaibRowFields(row), Option.some(fields))
      assert.deepStrictEqual(
        yield* ajaibRowFields({ ...row, lot: 0 }),
        Option.some({ ...fields, lots: 0 })
      )
    })
  )

  it.effect(
    "reads each board, a row without a known board on RG, and each side",
    () =>
      Effect.gen(function* () {
        const { market_type: _, ...unmarked } = row
        for (const [raw, board] of [
          [{ ...row, market_type: "RG" }, "RG"],
          [{ ...row, market_type: "TN" }, "TN"],
          [{ ...row, market_type: "NG" }, "NG"],
          [{ ...row, market_type: "XX" }, "RG"],
          [unmarked, "RG"],
        ] as const)
          assert.deepStrictEqual(
            Option.map(yield* ajaibRowFields(raw), (read) => read.board),
            Option.some(board),
            JSON.stringify(raw)
          )
        for (const [side, read] of [
          ["BUY", "buy"],
          ["sell", "sell"],
          ["", "none"],
        ] as const)
          assert.deepStrictEqual(
            Option.map(yield* ajaibRowFields({ ...row, side }), (r) => r.side),
            Option.some(read)
          )
      })
  )

  it.effect(
    "without a valid code, a whole price, lots of 0 or more, a side or a time has no fields",
    () =>
      Effect.gen(function* () {
        for (const bad of [
          { ...row, stock_code: "bbca" },
          { ...row, stock_code: undefined },
          { ...row, price: 8_000.5 },
          { ...row, price: "8000" },
          { ...row, lot: -1 },
          { ...row, lot: "1" },
          { ...row, side: undefined },
          { ...row, timestamp: undefined },
          { ...row, timestamp: "1794470398000" },
          null,
        ])
          assert.isTrue(
            Option.isNone(yield* ajaibRowFields(bad)),
            JSON.stringify(bad)
          )
      })
  )
})

describe("a Stockbit row", () => {
  const row = {
    trade_number: "1500490",
    time: "14:59:58",
    action: "sell",
    code: "BBCA",
    price: "8,000",
    lot: "0.5",
    market_board: "NG",
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

  it.effect(
    "gives the trade's fields from its grouped price and lots, its time WIB on the day",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* stockbitRowFields(DAY, row),
          Option.some(fields)
        )
        assert.deepStrictEqual(
          yield* stockbitRowFields(DAY, {
            ...row,
            price: "12,500",
            lot: "1,200",
            market_board: "RG",
          }),
          Option.some({
            ...fields,
            price: 12_500,
            lots: 1_200,
            board: "RG" as const,
          })
        )
      })
  )

  it.effect(
    "reads each board, a row without a known board on RG, and each side",
    () =>
      Effect.gen(function* () {
        const { market_board: _, ...unmarked } = row
        for (const [raw, board] of [
          [{ ...row, market_board: "RG" }, "RG"],
          [{ ...row, market_board: "TN" }, "TN"],
          [{ ...row, market_board: "NG" }, "NG"],
          [{ ...row, market_board: "XX" }, "RG"],
          [unmarked, "RG"],
        ] as const)
          assert.deepStrictEqual(
            Option.map(
              yield* stockbitRowFields(DAY, raw),
              (read) => read.board
            ),
            Option.some(board),
            JSON.stringify(raw)
          )
        const { action: _action, ...sideless } = row
        for (const [raw, side] of [
          [{ ...row, action: "buy" }, "buy"],
          [{ ...row, action: "SELL" }, "sell"],
          [sideless, "none"],
        ] as const)
          assert.deepStrictEqual(
            Option.map(yield* stockbitRowFields(DAY, raw), (read) => read.side),
            Option.some(side)
          )
      })
  )

  it.effect("gives the trade's buy and sell order numbers", () =>
    Effect.gen(function* () {
      // HOPE's trade 8799 on 2026-11-20: its group order is the buy's.
      assert.deepStrictEqual(
        yield* stockbitRowOrderNumbers({
          ...row,
          buy_order_number: "276574",
          sell_order_number: "53352",
          group_order_number: "276574",
        }),
        Option.some([276_574, 53_352] as const)
      )
    })
  )

  it.effect(
    "without both order numbers as positive integers has none, whatever its group order",
    () =>
      Effect.gen(function* () {
        const orders = {
          ...row,
          buy_order_number: "276574",
          sell_order_number: "53352",
        }
        for (const bad of [
          row,
          { ...row, group_order_number: "276574" },
          { ...orders, buy_order_number: "0" },
          { ...orders, sell_order_number: "0" },
          { ...orders, sell_order_number: "" },
          { ...orders, buy_order_number: "-3" },
          { ...orders, buy_order_number: "2765.74" },
          { ...orders, buy_order_number: "2,765" },
          { ...orders, sell_order_number: 53_352 },
          { ...orders, sell_order_number: "4294967296" },
          { ...orders, buy_order_number: undefined },
        ])
          assert.isTrue(
            Option.isNone(yield* stockbitRowOrderNumbers(bad)),
            JSON.stringify(bad)
          )
      })
  )

  it.effect(
    "without a valid code, a whole price, lots of 0 or more or a time has no fields",
    () =>
      Effect.gen(function* () {
        for (const bad of [
          { ...row, code: "" },
          { ...row, price: "8,000.5" },
          { ...row, price: "abc" },
          { ...row, lot: "-1" },
          { ...row, lot: 1 },
          { ...row, time: "9:00:00" },
          { ...row, time: "25:00:00" },
          { ...row, time: undefined },
          { trade_number: "1" },
        ])
          assert.isTrue(
            Option.isNone(yield* stockbitRowFields(DAY, bad)),
            JSON.stringify(bad)
          )
      })
  )
})
