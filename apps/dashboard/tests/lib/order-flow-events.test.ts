// How the page names order flow events: the spec's copy for each kind and
// side (spec apinrdw/kumora#605, "Order flow events: the rules").
import { assert, describe, it } from "@effect/vitest"
import { StockCode, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { eventKey } from "@/lib/book-events"
import {
  ORDER_FLOW_LETTERS,
  orderFlowEventFigures,
  orderFlowEventTitle,
} from "@/lib/order-flow-events"

const code = StockCode.make("BBCA")
const at = DateTime.makeUnsafe("2026-11-19T03:45:00.000Z")

const exhaustion: OrderFlowEvent = {
  kind: "exhaustion",
  code,
  at,
  side: "buy",
  price: 1250,
  lots: 900,
  peakLots: 2400,
  ticks: 2,
  widestTicks: 6,
}

const divergence: OrderFlowEvent = {
  kind: "divergence",
  code,
  at,
  side: "buy",
  price: 1250,
  delta: 8100,
  earlierAt: DateTime.makeUnsafe("2026-11-19T03:42:00.000Z"),
  earlierPrice: 1245,
  earlierDelta: 12_400,
}

const failedBreak: OrderFlowEvent = {
  kind: "failedBreak",
  code,
  at,
  side: "buy",
  price: 1250,
  to: 1260,
  value: 420_000_000,
  close: 1245,
  minutes: 2,
}

describe("order flow event copy", () => {
  it.effect("names Exhaustion with its lots and ranges", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* orderFlowEventTitle(exhaustion),
        "Buying exhaustion at the day's high"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures(exhaustion),
        "buy-aggressor lots 2,400 → 900 a minute · range 6 → 2 ticks"
      )
      const selling = { ...exhaustion, side: "sell" as const }
      assert.strictEqual(
        yield* orderFlowEventTitle(selling),
        "Selling exhaustion at the day's low"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures(selling),
        "sell-aggressor lots 2,400 → 900 a minute · range 6 → 2 ticks"
      )
    })
  )

  it.effect("names Delta divergence with both highs' cumulative delta", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* orderFlowEventTitle(divergence),
        "Delta divergence at the day's high"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures(divergence),
        "new high 1,250 · cumulative delta +8,100 lots vs +12,400 at 10:42's high 1,245"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures({
          ...divergence,
          side: "sell",
          delta: -400,
        }),
        "new low 1,250 · cumulative delta −400 lots vs +12,400 at 10:42's low 1,245"
      )
    })
  )

  it.effect("names a Failed break with how far and how soon", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* orderFlowEventTitle(failedBreak),
        "Failed break of the day's high"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures(failedBreak),
        "traded to 1,260 past 1,250 on Rp420 M buy-aggressor · closed back at 1,245 2 min later"
      )
      assert.strictEqual(
        yield* orderFlowEventFigures({
          ...failedBreak,
          side: "sell",
          minutes: 0,
        }),
        "traded to 1,260 past 1,250 on Rp420 M sell-aggressor · closed back at 1,245 the same minute"
      )
    })
  )

  it.effect("letters each kind and keys each event", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(ORDER_FLOW_LETTERS, {
        exhaustion: "E",
        divergence: "D",
        failedBreak: "F",
      })
      assert.strictEqual(
        yield* eventKey(exhaustion),
        `BBCA|exhaustion|buy|1250|${DateTime.toEpochMillis(at)}`
      )
    })
  )
})
