import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type RelayGap,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { withGapRows } from "@/components/market-live/gap-rows"
import type { TapeRow } from "@/lib/tape"

const at = (wib: string) => DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`)

const row = (tradeNumber: string, wib: string): TapeRow => ({
  kind: "trade",
  inFold: undefined,
  trade: {
    tradeNumber: TradeNumber.make(tradeNumber),
    time: at(wib),
    code: StockCode.make("BBCA"),
    price: 9_000,
    lots: 1,
    side: "buy",
    board: "RG",
    feeds: ["Ajaib"],
  },
})

const labels = (
  rows: ReadonlyArray<
    | TapeRow
    | { readonly kind: "gap"; readonly gap: RelayGap }
    | { readonly kind: "trade"; readonly trade: RunningTrade }
  >
) =>
  rows.map((each) =>
    each.kind === "trade"
      ? each.trade.tradeNumber
      : each.kind === "gap"
        ? "not recorded"
        : "fold"
  )

const WHOLE = { top: true, bottom: true }

describe("the tape's relay gap rows", () => {
  it.effect("a gap sits above the newest trade from before it", () =>
    Effect.gen(function* () {
      const rows = yield* withGapRows(
        [row("3", "10:05:00"), row("2", "10:00:30"), row("1", "09:59:00")],
        [{ from: at("10:00:45"), to: at("10:04:00") }],
        WHOLE
      )
      assert.deepStrictEqual(labels(rows), ["3", "not recorded", "2", "1"])
    })
  )

  it.effect(
    "a gap still open is on top, one older than every trade at the bottom",
    () =>
      Effect.gen(function* () {
        const gaps: ReadonlyArray<RelayGap> = [
          { from: at("08:58:00"), to: at("08:59:00") },
          { from: at("10:01:00") },
        ]
        const trades = [row("2", "10:00:30"), row("1", "10:00:00")]
        assert.deepStrictEqual(
          labels(yield* withGapRows(trades, gaps, WHOLE)),
          ["not recorded", "2", "1", "not recorded"]
        )
        // Rows in the middle of the list: neither edge is drawn.
        assert.deepStrictEqual(
          labels(
            yield* withGapRows(trades, gaps, { top: false, bottom: false })
          ),
          ["2", "1"]
        )
      })
  )
})
