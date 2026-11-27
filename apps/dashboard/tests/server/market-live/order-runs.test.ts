// Order-run pieces (spec apinrdw/kumora#627, "Slice 2", ticket
// apinrdw/kumora#629): trades go in through the ingest socket, the day
// seals, broker codes batches carry order numbers, and the test reads the
// sweep brokers GET.
import { gzipSync } from "node:zlib"

import { assert, describe, it } from "@effect/vitest"
import { StockCode, type SweepBrokers, type SweepPiece } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "@/server/market-live/day-store"

import { stockbitTrade, tradingDay } from "./day-harness"
// BBCA's Stockbit rows of 10:23:18 and 14:00:02 on 2026-11-20, trimmed
// from the capture on branch research/order-number-routes
// (docs/research/order-number-captures/sb-BBCA-2026-11-20.json.gz).
import bbca from "./fixtures/stockbit-bbca-order-runs-2026-11-20.json"
import { memorySql } from "./sql"

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

// A sealed day holding UNTR's sell sweep of trades 1.. at 09:00:10, each
// trade's lots in turn.
const sealedSellSweep = Effect.fnUntraced(function* (
  lots: ReadonlyArray<number>,
  sql: Sql = memorySql()
) {
  yield* at("09:01:10")
  const day = yield* tradingDay(sql)
  yield* day.trades(
    lots.map((each, index) =>
      stockbitTrade({
        number: index + 1,
        time: `09:00:10.${String(100 + index).padStart(3, "0")}`,
        price: 23300,
        lots: each,
        side: "sell",
      })
    )
  )
  yield* at("17:00:00")
  yield* day.alarm
  yield* at("17:30:00")
  return day
})

// Each piece as the test compares it: first trade, aggressor `code lots`,
// and its orders as `count first-last passive lots`, or none.
const pieceRow = (piece: SweepPiece) => [
  Number(piece.firstTrade),
  piece.aggressor.map((b) => `${b.code} ${b.lots}`).join(),
  piece.orders === undefined
    ? "none"
    : `${piece.orders.count} ${piece.orders.first}-${piece.orders.last} ${piece.orders.biggestPassiveLots}`,
]
const piecesOf = (sweep: SweepBrokers) => sweep.pieces.map(pieceRow)

// A row selling from `seller`'s order `sell` to KZ's order `buy`.
const sold = (
  number: number,
  seller: string,
  [buy, sell]: readonly [number, number]
): readonly [number, string, null, readonly [number, number]] => [
  number,
  `KZ D ${seller} D`,
  null,
  [buy, sell],
]

describe("a whole sweep every one of whose trades has order numbers", () => {
  it.effect(
    "joins one broker's orders stepping by at most 3 into one piece, another broker's order between them included",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedSellSweep([2, 3, 4, 5])
        yield* day.brokerCodes(
          "Ajaib",
          [
            sold(1, "AK", [900, 1001]),
            sold(2, "CC", [900, 1002]),
            sold(3, "AK", [900, 1004]),
            sold(4, "AK", [950, 1007]),
          ],
          4
        )
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        // KZ's order 900 took 2 + 4 lots of AK's run, order 950 took 5.
        assert.deepStrictEqual(answer.sweeps.flatMap(piecesOf), [
          [1, "AK 11", "3 1001-1007 6"],
          [2, "CC 3", "1 1002-1002 3"],
        ])
      })
  )

  it.effect(
    "starts a new piece where an order's number is more than 3 above the previous one's",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedSellSweep([2, 3, 4])
        yield* day.brokerCodes(
          "Ajaib",
          [
            sold(1, "AK", [900, 1001]),
            sold(2, "AK", [901, 1005]),
            sold(3, "AK", [902, 1005]),
          ],
          3
        )
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        // Order 1005 met two passive orders, 3 lots and 4: its biggest is 4.
        assert.deepStrictEqual(answer.sweeps.flatMap(piecesOf), [
          [1, "AK 2", "1 1001-1001 2"],
          [2, "AK 7", "1 1005-1005 4"],
        ])
      })
  )

  it.effect(
    "splits by aggressor broker, as before, when one trade lacks order numbers",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedSellSweep([2, 3, 4])
        yield* day.brokerCodes(
          "Ajaib",
          [
            sold(1, "AK", [900, 1001]),
            [2, "KZ D CC D"],
            sold(3, "AK", [900, 1009]),
          ],
          3
        )
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.flatMap(piecesOf), [
          [1, "AK 6", "none"],
          [2, "CC 3", "none"],
        ])
      })
  )

  it.effect(
    "regroups the minutes a batch carrying only order numbers touches",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedSellSweep([2, 3])
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "KZ D AK D"],
            [2, "KZ D AK D"],
          ],
          2
        )
        const before = (yield* day.recordedSweepBrokers("UNTR")).answer
        assert.deepStrictEqual(before.sweeps.flatMap(piecesOf), [
          [1, "AK 5", "none"],
        ])
        // Stockbit's walk resends the same codes with the order numbers.
        yield* day.brokerCodes("Stockbit", [
          sold(1, "AK", [900, 1001]),
          sold(2, "AK", [900, 1500]),
        ])
        const after = (yield* day.recordedSweepBrokers("UNTR")).answer
        assert.deepStrictEqual(after.sweeps.flatMap(piecesOf), [
          [1, "AK 2", "1 1001-1001 2"],
          [2, "AK 3", "1 1500-1500 3"],
        ])
      })
  )
})

// UNTR's 09:00 row's text as a day recorded before order runs stored it:
// one sell sweep of AK's trade 1 and CC's trade 2, each piece
// [sweep, aggressor, other] with no orders.
const OLD_ROW =
  '[["1",[[["sell","1",1794189610100,23300,23300,2,4660000,1],[["AK","D",2]],[["KZ","D",2]]],[["sell","2",1794189610200,23300,23300,3,6990000,1],[["CC","D",3]],[["KZ","F",3]]]]]]'

describe("a sweep brokers row stored before order runs", () => {
  it.effect("decodes and answers unchanged, and is never rebuilt", () =>
    Effect.gen(function* () {
      const sql = memorySql()
      const day = yield* sealedSellSweep([2, 3], sql)
      yield* day.brokerCodes(
        "Ajaib",
        [
          [1, "KZ D AK D"],
          [2, "KZ F CC D"],
        ],
        2
      )
      const stored = gzipSync(OLD_ROW)
      sql.exec("UPDATE sweep_brokers SET sweeps = ?", stored)
      const response = yield* day.recorded({
        _tag: "SweepBrokers",
        code: StockCode.make("UNTR"),
      })
      const text = yield* Effect.promise(() => response.text())
      assert.include(text, `"sweeps":${OLD_ROW}`)
      assert.deepStrictEqual(
        sql.exec("SELECT sweeps FROM sweep_brokers").map((row) => row.sweeps),
        [new Uint8Array(stored)]
      )
      const { answer } = yield* day.recordedSweepBrokers("UNTR")
      assert.deepStrictEqual(answer.sweeps.flatMap(piecesOf), [
        [1, "AK 2", "none"],
        [2, "CC 3", "none"],
      ])
    })
  )
})

// A captured Stockbit row's number, as the capture formats it ("2,544").
const counted = (text: string) => Number(text.replaceAll(",", ""))
// A captured broker, "CC [D]", as the harness's `CC D`.
const brokerOf = (text: string) => text.replace(/ \[(.)\]$/, " $1")

// A sealed day holding BBCA's captured trades of 10:23:18 and 14:00:02,
// each ingested in the minute after it.
const capturedDay = Effect.fnUntraced(function* () {
  const day = yield* tradingDay()
  for (const [time, after] of [
    ["10:23:18", "10:24:10"],
    ["14:00:02", "14:01:10"],
  ] as const) {
    yield* at(after)
    yield* day.trades(
      bbca
        .filter((row) => row.time === time)
        .map((row) =>
          stockbitTrade({
            number: Number(row.trade_number),
            time: `${row.time}.000`,
            code: "BBCA",
            price: counted(row.price),
            lots: counted(row.lot),
            side: row.action === "buy" ? "buy" : "sell",
          })
        )
    )
  }
  yield* at("17:00:00")
  yield* day.alarm
  yield* at("17:30:00")
  return day
})

// The capture's rows as batch rows, with their order numbers or without.
const capturedRows = (withOrders: boolean) =>
  bbca.map((row) => {
    const codes = `${brokerOf(row.buyer)} ${brokerOf(row.seller)}`
    const number = Number(row.trade_number)
    return withOrders
      ? ([
          number,
          codes,
          null,
          [Number(row.buy_order_number), Number(row.sell_order_number)],
        ] as const)
      : ([number, codes] as const)
  })

// The whole sweeps of BBCA's answer that start in the second at `time`.
const sweepsAt = (sweeps: ReadonlyArray<SweepBrokers>, time: string) =>
  sweeps.filter((sweep) =>
    DateTime.formatIsoOffset(
      DateTime.makeZonedUnsafe(sweep.pieces[0]!.time, { timeZone: "+07:00" })
    ).includes(`T${time}`)
  )

describe("BBCA's captured whole sweeps of 2026-11-20", () => {
  it.effect(
    "split XL's 10:23:18 sell sweep into a 22-order run and a 2-order run",
    () =>
      Effect.gen(function* () {
        const day = yield* capturedDay()
        yield* day.brokerCodes("Stockbit", capturedRows(true))
        const { answer } = yield* day.recordedSweepBrokers("BBCA")
        const [, sell] = sweepsAt(answer.sweeps, "10:23:18")
        // CP's order 6080 took 997 lots of the first run; HD's order 35372
        // took 1 + 3 of the second.
        assert.deepStrictEqual(
          sell!.pieces
            .filter((piece) => piece.aggressor[0]!.code === "XL")
            .map((piece) =>
              pieceRow(piece).filter((_, column) => column !== 1)
            ),
          [
            [464591, "22 1515610-1515642 997"],
            [464639, "2 1515648-1515650 4"],
          ]
        )
        // AK's two orders 2 apart join; YP's two, 17 apart, don't.
        assert.lengthOf(sell!.pieces, 9)
        const firsts = sell!.pieces.map((piece) => Number(piece.firstTrade))
        assert.deepStrictEqual(
          firsts,
          [...firsts].sort((a, b) => a - b)
        )
      })
  )

  it.effect(
    "split 14:00:02's retail rush from 165 per-broker pieces into 243 single orders once the order numbers land",
    () =>
      Effect.gen(function* () {
        const day = yield* capturedDay()
        yield* day.brokerCodes("Ajaib", capturedRows(false))
        const before = (yield* day.recordedSweepBrokers("BBCA")).answer
        const perBroker = sweepsAt(before.sweeps, "14:00:02")
        assert.lengthOf(perBroker, 104)
        assert.strictEqual(
          perBroker.reduce((count, sweep) => count + sweep.pieces.length, 0),
          165
        )
        yield* day.brokerCodes("Stockbit", capturedRows(true))
        const after = (yield* day.recordedSweepBrokers("BBCA")).answer
        const runs = sweepsAt(after.sweeps, "14:00:02").flatMap(
          (sweep) => sweep.pieces
        )
        assert.lengthOf(runs, 243)
        assert.isTrue(runs.every((piece) => piece.orders?.count === 1))
      })
  )
})
