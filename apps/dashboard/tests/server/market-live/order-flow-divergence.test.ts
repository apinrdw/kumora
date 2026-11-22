// Delta divergence from hand-made trades (spec apinrdw/kumora#605, "Testing
// Decisions"): it fires; an earlier high under 10 minutes back; a pullback
// under 3 ticks; a margin just under Rp100 M; an opening-auction earlier
// high; highs across the lunch break; the low mirror; relay gaps between the
// highs. Prices sit on the Rp5 tick (500–2,000): Rp100 M is 800 lots at
// 1,250. Its cumulative delta is the footprint chart's CVD.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  WibDate,
  type OrderFlowEvent,
  type RelayGap,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { minuteTotals } from "@/lib/footprint"
import { figuresOfTrades } from "@/server/market-live/candles"
import {
  addTrade,
  cellsOut,
  noCells,
} from "@/server/market-live/footprint-cells"
import { makeOrderFlow } from "@/server/market-live/order-flow"

// A Thursday.
const DAY = WibDate.make("2026-11-19")
const CODE = StockCode.make("BBCA")
const wib = (time: string) => Date.parse(`${DAY}T${time}+07:00`)
const MINUTE = 60_000

// One trade at the start of minute `at` (WIB, HH:MM).
interface Trade {
  readonly at: string
  readonly price: number
  readonly lots: number
  readonly side: RunningTrade["side"]
}
const t = (
  at: string,
  price: number,
  lots: number,
  side: RunningTrade["side"]
): Trade => ({ at, price, lots, side })

// A high of 1,245 on 09:30 with cumulative delta +2,500, a pullback to 1,230
// on `pullback` sell-aggressor lots, and a new high of 1,250 on 09:42 on
// 200 buy-aggressor lots: cumulative delta is lower by `pullback` − 200.
const run = (pullback = 1000, at = "09:42", low = 1230): Array<Trade> => [
  t("09:20", 1230, 500, "buy"),
  t("09:30", 1245, 2000, "buy"),
  t("09:35", low, pullback, "sell"),
  t(at, 1250, 200, "buy"),
]
const fired = (
  fields: Partial<Extract<OrderFlowEvent, { kind: "divergence" }>> = {}
): OrderFlowEvent => ({
  kind: "divergence",
  code: CODE,
  at: DateTime.makeUnsafe(wib("09:42:00")),
  side: "buy",
  price: 1250,
  delta: 1700,
  earlierAt: DateTime.makeUnsafe(wib("09:30:00")),
  earlierPrice: 1245,
  earlierDelta: 2500,
  ...fields,
})

const gap = (from: string, to: string): RelayGap => ({
  from: DateTime.makeUnsafe(wib(from)),
  to: DateTime.makeUnsafe(wib(to)),
})

// The trades fed to a fresh state as the candle book settles them, each a
// print of its own, judged 5 s past the last trade's minute under `gaps`.
// Returns the divergences found, and the footprint chart's CVD by minute
// for the same trades.
const judged = Effect.fnUntraced(function* (
  trades: ReadonlyArray<Trade>,
  gaps: ReadonlyArray<RelayGap> = []
) {
  const flow = yield* makeOrderFlow(DAY)
  const cells = new Map<number, Effect.Success<typeof noCells>>()
  let number = 1
  for (const trade of trades) {
    const minute = wib(`${trade.at}:00`)
    const running: RunningTrade = {
      tradeNumber: TradeNumber.make(String(number++)),
      time: DateTime.makeUnsafe(minute + 1_000),
      code: CODE,
      price: trade.price,
      lots: trade.lots,
      side: trade.side,
      board: "RG",
      feeds: ["Ajaib"],
    }
    flow.settled(CODE, minute, (yield* figuresOfTrades([running]))!)
    if (!cells.has(minute)) cells.set(minute, yield* noCells)
    yield* addTrade(cells.get(minute)!, running)
  }
  const footprints = []
  for (const [minute, each] of [...cells].sort(([a], [b]) => a - b))
    footprints.push({
      code: CODE,
      minute: DateTime.makeUnsafe(minute),
      cells: yield* cellsOut(each),
    })
  const cvd = new Map(
    (yield* minuteTotals(footprints)).map((row) => [row.minute, row.cvd])
  )
  const last = wib(`${trades.at(-1)!.at}:00`)
  const events = yield* flow.judge(last + MINUTE + 5_000, gaps)
  return {
    divergences: events.filter((event) => event.kind === "divergence"),
    cvd,
  }
})

const divergences = (
  trades: ReadonlyArray<Trade>,
  gaps?: ReadonlyArray<RelayGap>
) => Effect.map(judged(trades, gaps), (found) => found.divergences)

describe("Delta divergence", () => {
  it.effect("fires on a new high whose cumulative delta fell", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* divergences(run()), [fired()])
    })
  )

  it.effect("reads cumulative delta as the footprint chart's CVD", () =>
    Effect.gen(function* () {
      // No-side auction lots before the open, and both sides in a minute.
      const trades = [
        t("08:59", 1240, 3000, "none"),
        t("09:20", 1230, 500, "buy"),
        t("09:20", 1225, 300, "sell"),
        t("09:30", 1245, 2000, "buy"),
        t("09:30", 1240, 700, "none"),
        t("09:35", 1230, 1500, "sell"),
        t("09:35", 1235, 100, "buy"),
        t("09:42", 1250, 200, "buy"),
        t("09:42", 1245, 50, "sell"),
      ]
      const { divergences: found, cvd } = yield* judged(trades)
      assert.deepStrictEqual(found, [
        fired({
          delta: cvd.get(wib("09:42:00"))!,
          earlierDelta: cvd.get(wib("09:30:00"))!,
        }),
      ])
      assert.deepStrictEqual(
        [cvd.get(wib("09:30:00")), cvd.get(wib("09:42:00"))],
        [2200, 950]
      )
    })
  )

  it.effect("needs the earlier high at least 10 minutes back", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* divergences(run(1000, "09:39")), [])
      assert.deepStrictEqual(yield* divergences(run(1000, "09:40")), [
        fired({ at: DateTime.makeUnsafe(wib("09:40:00")) }),
      ])
    })
  )

  it.effect("needs price 3 ticks below the earlier high between them", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* divergences(run(1000, "09:42", 1235)), [])
    })
  )

  it.effect("needs cumulative delta lower by Rp100 M of lots", () =>
    Effect.gen(function* () {
      // 799 lots at 1,250 are Rp99.9 M.
      assert.deepStrictEqual(yield* divergences(run(999)), [])
    })
  )

  it.effect("compares with an opening-auction high at delta 0", () =>
    Effect.gen(function* () {
      const trades = [
        t("08:59", 1245, 1000, "none"),
        t("09:10", 1230, 1000, "sell"),
        t("09:20", 1250, 100, "buy"),
      ]
      assert.deepStrictEqual(yield* divergences(trades), [
        fired({
          at: DateTime.makeUnsafe(wib("09:20:00")),
          delta: -900,
          earlierAt: DateTime.makeUnsafe(wib("08:59:00")),
          earlierDelta: 0,
        }),
      ])
    })
  )

  it.effect("compares highs across the lunch break", () =>
    Effect.gen(function* () {
      const trades = [
        t("11:40", 1230, 500, "buy"),
        t("11:50", 1245, 2000, "buy"),
        t("11:55", 1230, 1000, "sell"),
        t("13:35", 1250, 200, "buy"),
      ]
      assert.deepStrictEqual(yield* divergences(trades), [
        fired({
          at: DateTime.makeUnsafe(wib("13:35:00")),
          earlierAt: DateTime.makeUnsafe(wib("11:50:00")),
        }),
      ])
    })
  )

  it.effect("mirrors at the day's low with cumulative delta higher", () =>
    Effect.gen(function* () {
      // Rp100 M at 1,150 is 869.6 lots: 900 higher fires.
      const trades = [
        t("09:20", 1170, 500, "sell"),
        t("09:30", 1155, 2000, "sell"),
        t("09:35", 1170, 1100, "buy"),
        t("09:42", 1150, 200, "sell"),
      ]
      assert.deepStrictEqual(yield* divergences(trades), [
        fired({
          side: "sell",
          price: 1150,
          delta: -1600,
          earlierPrice: 1155,
          earlierDelta: -2500,
        }),
      ])
      assert.deepStrictEqual(
        yield* divergences(
          trades.map((each) =>
            each.at === "09:35" ? { ...each, lots: 1069 } : each
          )
        ),
        []
      )
    })
  )

  it.effect("is blocked by a 10 s relay gap between the highs", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* divergences(run(), [gap("09:36:00", "09:36:10")]),
        []
      )
      assert.deepStrictEqual(
        yield* divergences(run(), [gap("09:36:00", "09:36:09")]),
        [fired()]
      )
      // One before the earlier high leaves it be.
      assert.deepStrictEqual(
        yield* divergences(run(), [gap("09:25:00", "09:25:30")]),
        [fired()]
      )
    })
  )
})
