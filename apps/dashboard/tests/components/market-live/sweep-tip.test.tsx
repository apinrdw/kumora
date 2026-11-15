// @vitest-environment happy-dom
import {
  BrokerCode,
  StockCode,
  TradeNumber,
  type Sweep,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

import { makeSweepStore } from "@/components/market-live/sweep-store"
import { SweepTip } from "@/components/market-live/sweep-tip"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const BBCA = StockCode.make("BBCA")
const buy: Sweep = {
  side: "buy",
  firstTrade: TradeNumber.make("1"),
  time: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  first: 1_000,
  last: 1_000,
  lots: 30,
  value: 3_000_000,
  trades: 1,
}

test("an open tooltip shows a sweep's brokers once a recheck brings them", async () => {
  const store = Effect.runSync(makeSweepStore(BBCA))
  store.answer(0, { code: BBCA, sweeps: [buy] })
  store.answerBrokers({ code: BBCA, sweeps: [], complete: false })
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  await act(() => root.render(<SweepTip store={store} withBrokers />))
  await act(() =>
    store.tip.set({ id: buy.firstTrade, x: 10, y: 10, from: "chart" })
  )
  const tip = () => document.querySelector('[role="tooltip"]')?.textContent
  expect(tip()).toContain("Brokers show once every trade")

  await act(() =>
    store.answerBrokers({
      code: BBCA,
      sweeps: [
        {
          firstTrade: buy.firstTrade,
          aggressor: [
            { code: BrokerCode.make("AK"), investorType: "F", lots: 30 },
          ],
          other: [{ code: BrokerCode.make("CC"), investorType: "D", lots: 30 }],
        },
      ],
      complete: true,
    })
  )
  expect(tip()).toContain("AK [F]")
  expect(tip()).toContain("CC [D]")
  await act(() => root.unmount())
})
