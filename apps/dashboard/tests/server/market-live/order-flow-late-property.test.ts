// Late trades, any of them (spec apinrdw/kumora#605, "Order flow events: the
// rules"): random days of one share's trades, fed in order and again with
// some trades arriving up to 5 minutes after their minute was judged. The
// late run finds every event the in-order run finds, as it finds it, once
// the late trades are in; an event it sent before a late trade for its
// minute or an earlier one arrived may stand as it was sent.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeOrderFlow } from "@/server/market-live/order-flow"

// A Thursday.
const DAY = WibDate.make("2026-11-19")
const CODE = StockCode.make("BBCA")
const MINUTE = 60_000
const OPEN = Date.parse(`${DAY}T09:00:00+07:00`)
// 09:00–10:59, all of Session 1's continuous trading this test feeds.
const MINUTES = 120
const SEEDS = 300

interface Trade {
  readonly minute: number
  // The minute whose judging it arrives before: its own when in order.
  readonly arrives: number
  readonly price: number
  readonly lots: number
  readonly side: "buy" | "sell"
  readonly order: bigint
}

// mulberry32: the same day for the same seed.
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

// A random walk on the Rp5 tick between 1,000 and 1,900 in pushes of a few
// minutes, 0 to 5 trades a minute, about one in six arriving 1 to 5 minutes
// late.
const dayOf = (seed: number) => {
  const next = random(seed)
  const between = (low: number, high: number) =>
    low + Math.floor(next() * (high - low + 1))
  const trades: Array<Trade> = []
  let price = 1_400
  let drift = 0
  let order = 1n
  for (let index = 0; index < MINUTES; index++) {
    const minute = OPEN + index * MINUTE
    if (index % between(3, 6) === 0) drift = between(-2, 2)
    const count = between(0, 5)
    for (let each = 0; each < count; each++) {
      const step = drift + between(-2, 2)
      price = Math.min(1_900, Math.max(1_000, price + 5 * step))
      const late = index > 0 && next() < 1 / 6
      trades.push({
        minute,
        arrives: late ? minute + between(1, 5) * MINUTE : minute,
        price,
        lots: between(1, 30) * between(1, 100),
        side: step > 0 || (step === 0 && next() < 0.5) ? "buy" : "sell",
        order: order++,
      })
    }
  }
  return trades
}

type Flow = Effect.Success<ReturnType<typeof makeOrderFlow>>

const settle = (flow: Flow, trade: Trade) => {
  const value = trade.price * trade.lots * 100
  flow.settled(CODE, trade.minute, {
    closeOrder: trade.order,
    close: trade.price,
    volume: trade.lots,
    buyValue: trade.side === "buy" ? value : 0,
    sellValue: trade.side === "sell" ? value : 0,
  })
}

// An event found, and the minute whose judging found it.
interface Found {
  readonly event: OrderFlowEvent
  readonly judged: number
}

// Every minute's arrivals settled, then the minute judged 5 s past its
// close, through 10 minutes past the last.
const run = Effect.fnUntraced(function* (
  trades: ReadonlyArray<Trade>,
  arrives: (trade: Trade) => number
) {
  const flow = yield* makeOrderFlow(DAY)
  const found: Array<Found> = []
  for (let index = 0; index < MINUTES + 10; index++) {
    const minute = OPEN + index * MINUTE
    for (const trade of trades)
      if (arrives(trade) === minute) settle(flow, trade)
    for (const event of yield* flow.judge(minute + MINUTE + 5_000, []))
      found.push({ event, judged: minute })
  }
  return found
})

const keyOf = (event: OrderFlowEvent) =>
  `${event.kind}|${event.side}|${DateTime.toEpochMillis(event.at)}`

describe("Late trades", () => {
  it.effect(
    "leave the events as the same trades fed in order find them",
    () =>
      Effect.gen(function* () {
        let compared = 0
        for (let seed = 1; seed <= SEEDS; seed++) {
          const trades = dayOf(seed)
          const inOrder = yield* run(trades, (trade) => trade.minute)
          const late = yield* run(trades, (trade) => trade.arrives)
          compared += inOrder.length
          const expected = new Map(
            inOrder.map(({ event }) => [keyOf(event), event])
          )
          const sent = new Map(late.map(({ event }) => [keyOf(event), event]))
          for (const key of expected.keys())
            assert.isTrue(sent.has(key), `seed ${seed}: ${key} sent`)
          for (const { event, judged } of late) {
            const at = DateTime.toEpochMillis(event.at)
            const stale = trades.some(
              (trade) => trade.minute <= at && trade.arrives > judged
            )
            if (!stale)
              assert.deepStrictEqual(
                event,
                expected.get(keyOf(event)),
                `seed ${seed}: ${keyOf(event)} sent after its late trades`
              )
          }
          assert.strictEqual(
            late.length,
            sent.size,
            `seed ${seed}: each event sent once`
          )
        }
        assert.isAbove(compared, 100, "the days find events to compare")
      }),
    60_000
  )
})
