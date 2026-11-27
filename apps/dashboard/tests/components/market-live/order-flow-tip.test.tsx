// @vitest-environment happy-dom
// The order flow marks' tooltip (spec apinrdw/kumora#605, "Order flow
// events: on the page"): hovering or tapping a mark shows its event's title
// and figures.
import { StockCode, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

import { makeBookEventStore } from "@/components/market-live/book-event-store"
import { makeListenerStore } from "@/components/market-live/listener-store"
import type { OrderFlowTipAt } from "@/components/market-live/order-flow-marks"
import { OrderFlowTip } from "@/components/market-live/order-flow-tip"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const code = StockCode.make("BBCA")
const exhaustion: OrderFlowEvent = {
  kind: "exhaustion",
  code,
  at: DateTime.makeUnsafe("2026-11-19T03:45:00.000Z"),
  side: "buy",
  price: 1250,
  lots: 900,
  peakLots: 2400,
  ticks: 1,
  widestTicks: 5,
}

test("a mark's tooltip names its event and its figures", async () => {
  const store = Effect.runSync(makeBookEventStore(code))
  store.loadOrderFlow({ code, recorded: true, events: [exhaustion] })
  const tip = Effect.runSync(
    makeListenerStore<OrderFlowTipAt | undefined>(undefined)
  )
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  await act<void>(() => root.render(<OrderFlowTip tip={tip} store={store} />))
  const shown = () => document.querySelector('[role="tooltip"]')?.textContent
  expect(shown()).toBeUndefined()

  await act<void>(() =>
    tip.set({
      key: `BBCA|exhaustion|buy|1250|${Date.parse("2026-11-19T03:45:00.000Z")}`,
      x: 10,
      y: 10,
      pinned: false,
    })
  )
  expect(shown()).toContain("10:45 · Buying exhaustion at the day's high")
  expect(shown()).toContain(
    "buy-aggressor lots 2,400 → 900 a minute · range 5 → 1 ticks"
  )

  await act<void>(() => tip.set({ key: "gone", x: 10, y: 10, pinned: false }))
  expect(shown(), "an event the store no longer holds").toBeUndefined()
  await act<void>(() => root.unmount())
})
