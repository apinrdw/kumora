// Failed break from hand-made minutes (spec apinrdw/kumora#605, "Testing
// Decisions"): a one-minute wick, a return on the third minute, no return,
// value under Rp100 M, a return across the lunch break and the low mirror.
// Prices sit on the Rp5 tick (500–2,000). The day's high 1,250 is set at
// 09:30; every break below comes at least 10 minutes later.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  type OrderFlowEvent,
  type RelayGap,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeOrderFlow } from "@/server/market-live/order-flow"

// A Thursday.
const DAY = WibDate.make("2026-11-19")
const CODE = StockCode.make("BBCA")
const wib = (time: string) => Date.parse(`${DAY}T${time}+07:00`)
const MINUTE = 60_000

type Side = "buy" | "sell"

// One trade: its price, lots and aggressor side.
type Trade = readonly [price: number, lots: number, side: Side]

// One minute's trades in order: the last one is its close.
interface Minute {
  readonly at: string
  readonly trades: ReadonlyArray<Trade>
}
const m = (at: string, ...trades: ReadonlyArray<Trade>): Minute => ({
  at,
  trades,
})

// The day's high 1,250 at 09:30, closing at 1,245.
const LEVEL: ReadonlyArray<Minute> = [
  m("09:30", [1240, 100, "buy"], [1250, 100, "buy"], [1245, 100, "sell"]),
]

let order = 1n
// The minutes' trades fed to a fresh state, judged 5 s past the last
// minute's close under `gaps`. A selling run mirrors each price about
// 1,200 and swaps each trade's side.
const run = Effect.fnUntraced(function* (
  minutes: ReadonlyArray<Minute>,
  options: {
    readonly mirror?: boolean
    readonly gaps?: ReadonlyArray<RelayGap>
  } = {}
) {
  const flow = yield* makeOrderFlow(DAY)
  for (const minute of minutes)
    for (const [first, lots, aggressor] of minute.trades) {
      const price = options.mirror === true ? 2400 - first : first
      const side: Side =
        options.mirror === true
          ? aggressor === "buy"
            ? "sell"
            : "buy"
          : aggressor
      const value = price * lots * 100
      flow.settled(CODE, wib(`${minute.at}:00`), {
        closeOrder: order++,
        close: price,
        volume: lots,
        buyValue: side === "buy" ? value : 0,
        sellValue: side === "sell" ? value : 0,
      })
    }
  const last = wib(`${minutes.at(-1)!.at}:00`)
  const events = yield* flow.judge(last + MINUTE + 5_000, options.gaps ?? [])
  return events.filter((event) => event.kind === "failedBreak")
})

const failedBreak = (
  at: string,
  fields: Partial<Extract<OrderFlowEvent, { kind: "failedBreak" }>> = {}
): OrderFlowEvent => ({
  kind: "failedBreak",
  code: CODE,
  at: DateTime.makeUnsafe(wib(`${at}:00`)),
  side: "buy",
  price: 1250,
  to: 1255,
  value: 125_500_000,
  close: 1245,
  minutes: 0,
  ...fields,
})

// A wick at 09:45: Rp125.5 M of buy aggressors at 1,255, 500 lots at the
// level that don't count, and a close back at 1,245.
const WICK: ReadonlyArray<Minute> = [
  ...LEVEL,
  m("09:45", [1250, 500, "buy"], [1255, 1000, "buy"], [1245, 10, "sell"]),
]

describe("Failed break", () => {
  it.effect("fires on a one-minute wick past the day's high", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(WICK), [failedBreak("09:45")])
    })
  )

  it.effect("fires on a return in the third minute, not the fourth", () =>
    Effect.gen(function* () {
      // Rp100.6 M past 1,250 over 09:45 and 09:46, out to 1,260.
      const out = [
        ...LEVEL,
        m("09:45", [1255, 400, "buy"]),
        m("09:46", [1260, 400, "buy"], [1255, 10, "sell"]),
      ]
      assert.deepStrictEqual(
        yield* run([
          ...out,
          m("09:47", [1250, 10, "sell"], [1245, 10, "sell"]),
        ]),
        [
          failedBreak("09:47", {
            to: 1260,
            value: 100_600_000,
            minutes: 2,
          }),
        ]
      )
      // Closing at the level is not back inside.
      assert.deepStrictEqual(
        yield* run([
          ...out,
          m("09:47", [1250, 10, "sell"]),
          m("09:48", [1245, 10, "sell"]),
        ]),
        []
      )
    })
  )

  it.effect("needs the level set at least 10 minutes before", () =>
    Effect.gen(function* () {
      const early = (at: string) => [
        ...LEVEL,
        m(at, [1255, 1000, "buy"], [1245, 10, "sell"]),
      ]
      assert.deepStrictEqual(yield* run(early("09:39")), [])
      assert.deepStrictEqual(yield* run(early("09:40")), [failedBreak("09:40")])
    })
  )

  it.effect("makes a break that stays out the day's high", () =>
    Effect.gen(function* () {
      // Out to 1,260 at 09:45 and no close back by 09:47.
      const out = [
        ...LEVEL,
        m("09:45", [1255, 1000, "buy"], [1260, 10, "buy"]),
        m("09:46", [1255, 10, "sell"]),
        m("09:47", [1255, 10, "sell"]),
        m("09:48", [1245, 10, "sell"]),
      ]
      assert.deepStrictEqual(yield* run(out), [])
      // 1,260 is a level from 09:55, and 1,250 no longer is.
      const wick = (at: string) =>
        m(at, [1265, 1000, "buy"], [1255, 10, "sell"])
      assert.deepStrictEqual(yield* run([...out, wick("09:54")]), [])
      assert.deepStrictEqual(yield* run([...out, wick("09:55")]), [
        failedBreak("09:55", {
          price: 1260,
          to: 1265,
          value: 126_500_000,
          close: 1255,
        }),
      ])
    })
  )

  it.effect("needs Rp100 M of buy-aggressor value past the level", () =>
    Effect.gen(function* () {
      // 796 lots at 1,255 are Rp99.9 M; 797 are Rp100.02 M.
      const wick = (lots: number) => [
        ...LEVEL,
        m("09:45", [1255, lots, "buy"], [1245, 10, "sell"]),
      ]
      assert.deepStrictEqual(yield* run(wick(796)), [])
      assert.deepStrictEqual(yield* run(wick(797)), [
        failedBreak("09:45", { value: 100_023_500 }),
      ])
    })
  )

  it.effect("needs the return in the break's session", () =>
    Effect.gen(function* () {
      // Out at 11:59, Session 1's last minute; back at 13:30.
      assert.deepStrictEqual(
        yield* run([
          ...LEVEL,
          m("11:59", [1255, 1000, "buy"]),
          m("13:30", [1245, 10, "sell"]),
        ]),
        []
      )
    })
  )

  it.effect("mirrors at the day's low on selling", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(WICK, { mirror: true }), [
        failedBreak("09:45", {
          side: "sell",
          price: 1150,
          to: 1145,
          value: 114_500_000,
          close: 1155,
        }),
      ])
    })
  )

  it.effect("is blocked by a 10 s relay gap from the break to the return", () =>
    Effect.gen(function* () {
      const gap = (from: string, to: string): RelayGap => ({
        from: DateTime.makeUnsafe(wib(from)),
        to: DateTime.makeUnsafe(wib(to)),
      })
      assert.deepStrictEqual(
        yield* run(WICK, { gaps: [gap("09:45:10", "09:45:19")] }),
        [failedBreak("09:45")]
      )
      assert.deepStrictEqual(
        yield* run(WICK, { gaps: [gap("09:45:10", "09:45:20")] }),
        []
      )
    })
  )
})
