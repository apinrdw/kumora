import { assert, describe, it } from "@effect/vitest"
import { StockCode, TradeNumber, type RunningTrade } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { withGapRows } from "@/components/market-live/gap-rows"

const at = (wib: string) => DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`)

const trade = (tradeNumber: string, wib: string): RunningTrade => ({
  tradeNumber: TradeNumber.make(tradeNumber),
  time: at(wib),
  code: StockCode.make("BBCA"),
  price: 9_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Ajaib"],
})

const labels = (
  rows: ReadonlyArray<
    | { kind: "trade"; trade: RunningTrade }
    | { kind: "gap"; gap: { from: DateTime.Utc } }
  >
) =>
  rows.map((row) =>
    row.kind === "trade" ? row.trade.tradeNumber : "not recorded"
  )

describe("the tape's relay gap rows", () => {
  it.effect("a gap sits above the newest trade from before it", () =>
    Effect.gen(function* () {
      const rows = yield* withGapRows(
        [
          trade("3", "10:05:00"),
          trade("2", "10:00:30"),
          trade("1", "09:59:00"),
        ],
        [{ from: at("10:00:45"), to: at("10:04:00") }]
      )
      assert.deepStrictEqual(labels(rows), ["3", "not recorded", "2", "1"])
    })
  )

  it.effect(
    "a gap still open is on top, one older than every trade at the bottom",
    () =>
      Effect.gen(function* () {
        const rows = yield* withGapRows(
          [trade("2", "10:00:30"), trade("1", "10:00:00")],
          [
            { from: at("08:58:00"), to: at("08:59:00") },
            { from: at("10:01:00") },
          ]
        )
        assert.deepStrictEqual(labels(rows), [
          "not recorded",
          "2",
          "1",
          "not recorded",
        ])
      })
  )
})
