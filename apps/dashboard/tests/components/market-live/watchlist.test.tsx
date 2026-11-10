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

test("a Day state without a change, an index's whose frames carry no previous close, shows none rather than 0%", () => {
  const IHSG = StockCode.make("IHSG")
  const store = makeDayStateStore()
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  act(() =>
    root.render(
      <Watchlist
        codes={[IHSG]}
        list={{ _tag: "Loading" }}
        store={store}
        onAdd={() => {}}
        onRemove={() => {}}
        onSelect={() => {}}
      />
    )
  )
  act(() =>
    store.replace([
      {
        code: IHSG,
        last: 4971.287,
        open: 4955.834,
        high: 4983.81,
        low: 4925.101,
        volume: 241_870_237,
        value: 4_224_616_955_900,
        frequency: 674_825,
        asOf: DateTime.makeUnsafe("2026-11-09T14:19:27+07:00"),
        provenance: "Stockbit",
      },
    ])
  )
  const cells = [...container.querySelectorAll('tr[data-code="IHSG"] td')].map(
    (cell) => cell.textContent
  )
  expect(cells.slice(1, 3)).toEqual(["4,971.29", "—"])
  act(() => root.unmount())
})
