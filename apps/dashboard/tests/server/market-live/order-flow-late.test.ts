// A late trade (spec apinrdw/kumora#605, "Order flow events: the rules"): one
// the candle book settles into a minute the rules already judged. When it
// moves the day's high or low, that new extreme is judged once, as the
// minute it traded in, and finds what the same trades fed in order (as a
// restart replays them) find. Prices sit on the Rp5 tick.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeOrderFlow } from "@/server/market-live/order-flow"

// A Thursday.
const DAY = WibDate.make("2026-11-19")
const CODE = StockCode.make("BBCA")
const wib = (time: string) => Date.parse(`${DAY}T${time}+07:00`)
const MINUTE = 60_000

// One trade at minute `at` (HH:MM): its price, lots, aggressor side and its
// order on the tape, which decides a minute's close.
interface Trade {
  readonly at: string
  readonly price: number
  readonly lots: number
  readonly side: "buy" | "sell"
  readonly order: bigint
}
let next = 1n
const t = (
  at: string,
  price: number,
  lots: number,
  side: Trade["side"],
  order = next++
): Trade => ({ at, price, lots, side, order })

type Flow = Effect.Success<ReturnType<typeof makeOrderFlow>>

const settle = (flow: Flow, trade: Trade) => {
  const value = trade.price * trade.lots * 100
  flow.settled(CODE, wib(`${trade.at}:00`), {
    closeOrder: trade.order,
    close: trade.price,
    volume: trade.lots,
    buyValue: trade.side === "buy" ? value : 0,
    sellValue: trade.side === "sell" ? value : 0,
  })
}

// 5 s past `at`'s minute close.
const dueAfter = (at: string) => wib(`${at}:00`) + MINUTE + 5_000

// The trades settled and judged through `through`'s minute, then the late
// ones settled into it and judged again: every event found, in order.
const live = Effect.fnUntraced(function* (
  trades: ReadonlyArray<Trade>,
  through: string,
  late: ReadonlyArray<Trade>,
  after: ReadonlyArray<Trade> = []
) {
  const flow = yield* makeOrderFlow(DAY)
  for (const trade of trades) settle(flow, trade)
  const found = [...(yield* flow.judge(dueAfter(through), []))]
  for (const trade of late) settle(flow, trade)
  found.push(...(yield* flow.judge(dueAfter(through) + 5_000, [])))
  for (const trade of after) settle(flow, trade)
  const last = after.at(-1)?.at ?? through
  found.push(...(yield* flow.judge(dueAfter(last), [])))
  found.push(...(yield* flow.judge(dueAfter(last) + 5_000, [])))
  return found
})

// The same trades settled before any minute is judged, as a restart
// replays them.
const inOrder = Effect.fnUntraced(function* (
  trades: ReadonlyArray<Trade>,
  through: string
) {
  const flow = yield* makeOrderFlow(DAY)
  for (const trade of trades) settle(flow, trade)
  return yield* flow.judge(dueAfter(through), [])
})

const without = (events: ReadonlyArray<OrderFlowEvent>, kind: string) =>
  events.filter((event) => event.kind !== kind)

describe("A late trade that moves the day's extreme", () => {
  it.effect("is judged for Delta divergence as its own minute", () =>
    Effect.gen(function* () {
      // A high of 1,245 at 09:30 on cumulative delta +2,500, a pullback to
      // 1,230, and 09:42 trading only 1,240 until a late 1,250.
      const trades = [
        t("09:20", 1230, 500, "buy"),
        t("09:30", 1245, 2000, "buy"),
        t("09:35", 1230, 1000, "sell"),
        t("09:42", 1240, 100, "buy"),
      ]
      const late = [t("09:42", 1250, 100, "buy")]
      const expected: OrderFlowEvent = {
        kind: "divergence",
        code: CODE,
        at: DateTime.makeUnsafe(wib("09:42:00")),
        side: "buy",
        price: 1250,
        delta: 1700,
        earlierAt: DateTime.makeUnsafe(wib("09:30:00")),
        earlierPrice: 1245,
        earlierDelta: 2500,
      }
      const found = yield* live(trades, "09:42", late)
      assert.deepStrictEqual(
        found.filter((event) => event.kind === "divergence"),
        [expected],
        "judged once"
      )
      assert.deepStrictEqual(
        (yield* inOrder([...trades, ...late], "09:42")).filter(
          (event) => event.kind === "divergence"
        ),
        [expected],
        "as a restart replays it"
      )
    })
  )

  it.effect("starts a Failed break as its own minute", () =>
    Effect.gen(function* () {
      // The day's high 1,250 at 09:30; 09:45 closes at 1,245 and a late
      // trade earlier on the tape reached 1,255 on Rp125.5 M.
      const trades = [
        t("09:30", 1250, 100, "buy"),
        t("09:30", 1245, 100, "sell"),
        t("09:45", 1245, 10, "buy"),
      ]
      const late = [t("09:45", 1255, 1000, "buy", 0n)]
      const expected: OrderFlowEvent = {
        kind: "failedBreak",
        code: CODE,
        at: DateTime.makeUnsafe(wib("09:45:00")),
        side: "buy",
        price: 1250,
        to: 1255,
        value: 125_500_000,
        close: 1245,
        minutes: 0,
      }
      const found = without(yield* live(trades, "09:45", late), "exhaustion")
      assert.deepStrictEqual(found, [expected])
      assert.deepStrictEqual(
        without(yield* inOrder([...trades, ...late], "09:45"), "exhaustion"),
        [expected]
      )
    })
  )

  it.effect("adds its value to a break under way once", () =>
    Effect.gen(function* () {
      // 09:45 breaks out to 1,255 on Rp50.2 M and stays out; a late 1,260
      // adds Rp50.4 M; 09:46 closes back inside.
      const trades = [
        t("09:30", 1250, 100, "buy"),
        t("09:30", 1245, 100, "sell"),
        t("09:45", 1255, 400, "buy"),
      ]
      const late = [t("09:45", 1260, 400, "buy", 0n)]
      const after = [t("09:46", 1245, 10, "sell")]
      const expected: OrderFlowEvent = {
        kind: "failedBreak",
        code: CODE,
        at: DateTime.makeUnsafe(wib("09:46:00")),
        side: "buy",
        price: 1250,
        to: 1260,
        value: 100_600_000,
        close: 1245,
        minutes: 1,
      }
      assert.deepStrictEqual(
        without(yield* live(trades, "09:45", late, after), "exhaustion"),
        [expected]
      )
      assert.deepStrictEqual(
        without(
          yield* inOrder([...trades, ...late, ...after], "09:46"),
          "exhaustion"
        ),
        [expected]
      )
    })
  )

  it.effect(
    "is judged 9 minutes behind a day folded in one judge, as a restart folds it",
    () =>
      Effect.gen(function* () {
        // The break above, folded through 09:54 with the minutes before it:
        // too small until the late 1,260 adds its Rp50.4 M to 09:45.
        const trades = [
          t("09:30", 1250, 100, "buy"),
          t("09:30", 1245, 100, "sell"),
          t("09:45", 1255, 400, "buy"),
          t("09:46", 1245, 10, "sell"),
        ]
        const late = [t("09:45", 1260, 400, "buy", 0n)]
        const expected = without(
          yield* inOrder([...trades, ...late], "09:54"),
          "exhaustion"
        )
        assert.deepStrictEqual(
          expected.map((event) => [event.kind, event.price]),
          [["failedBreak", 1250]]
        )
        assert.deepStrictEqual(
          without(yield* live(trades, "09:54", late), "exhaustion"),
          expected
        )
      })
  )
})
