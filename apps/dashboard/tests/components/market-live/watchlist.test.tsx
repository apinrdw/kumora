// @vitest-environment happy-dom
import { StockCode } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

import { makeDayStateStore } from "@/components/market-live/day-state-store"
import {
  applyConditions,
  resetConditions,
} from "@/components/market-live/market-conditions"
import { Watchlist } from "@/components/market-live/watchlist"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const BBCA = StockCode.make("BBCA")

test("a code with an indicative price before any Day state shows the indicative price, not 'no data yet'", () => {
  const store = makeDayStateStore()
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  act(() =>
    root.render(
      <Watchlist
        codes={[BBCA]}
        list={{ _tag: "Loading" }}
        store={store}
        onAdd={() => {}}
        onRemove={() => {}}
        onSelect={() => {}}
      />
    )
  )
  const row = container.querySelector('tr[data-code="BBCA"]')!
  expect(row.textContent).toContain("no data yet")
  // Pre-opening: the first frame of BBCA's day is its indicative price.
  act(() =>
    Effect.runSync(
      applyConditions({
        _tag: "Snapshot",
        selected: BBCA,
        tape: [],
        candles: [],
        conditions: {
          phase: "pre-opening",
          relayOnline: true,
          feeds: { Stockbit: "live", Ajaib: "live" },
          gaps: [],
        },
        indicative: [
          {
            code: BBCA,
            price: 5_325,
            volume: 1_500,
            at: DateTime.makeUnsafe("2026-11-09T08:50:01+07:00"),
          },
        ],
      })
    )
  )
  expect(row.textContent).toContain("Indicative")
  expect(row.textContent).toContain("5,325")
  expect(row.textContent).not.toContain("no data yet")
  act(() => Effect.runSync(resetConditions))
  act(() => root.unmount())
})
